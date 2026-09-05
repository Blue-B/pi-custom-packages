import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	ModelRuntime,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { withFileLock } from "./lock.ts";
import { modelForAccount } from "./model.ts";
import {
	exhaustedResetAt,
	isAccountAvailable,
	type Window,
} from "./quota.ts";

type Credential = {
	type?: string;
	access?: string;
	refresh?: string;
	expires?: number;
	accountId?: string;
};
type UsageBody = {
	plan_type?: string;
	rate_limit?: {
		allowed?: boolean;
		primary_window?: Window;
		secondary_window?: Window;
	};
};
type Account = Awaited<ReturnType<typeof fetchAccount>>;
type TokenUsage = {
	resetAt?: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
	seen: string[];
};
type TokenUsageState = Record<string, TokenUsage>;
type LegacyOAuthCallbacks = {
	onAuth(info: { url: string; instructions?: string }): void;
	onDeviceCode(info: {
		userCode: string;
		verificationUri: string;
		intervalSeconds?: number;
		expiresInSeconds?: number;
	}): void;
	onPrompt(prompt: { message: string; placeholder?: string }): Promise<string>;
	onProgress?(message: string): void;
	onManualCodeInput?(): Promise<string>;
	onSelect(prompt: {
		message: string;
		options: Array<{ id: string; label: string }>;
	}): Promise<string | undefined>;
	signal?: AbortSignal;
};

async function createCodexConfig() {
	const runtime = await ModelRuntime.create();
	const modern = runtime.getProvider("openai-codex")?.auth.oauth;
	if (!modern) throw new Error("OpenAI Codex OAuth provider unavailable");
	return {
		oauth: {
			name: modern.name,
			async login(callbacks: LegacyOAuthCallbacks) {
				return modern.login({
					signal: callbacks.signal ?? new AbortController().signal,
					async prompt(prompt) {
						if (prompt.type === "select") {
							const selected = await callbacks.onSelect({
								message: prompt.message,
								options: prompt.options.map(({ id, label }) => ({ id, label })),
							});
							if (!selected) throw new Error("Login cancelled");
							return selected;
						}
						if (prompt.type === "manual_code" && callbacks.onManualCodeInput)
							return callbacks.onManualCodeInput();
						return callbacks.onPrompt({
							message: prompt.message,
							placeholder: prompt.placeholder,
						});
					},
					notify(event) {
						if (event.type === "auth_url") callbacks.onAuth(event);
						else if (event.type === "device_code") callbacks.onDeviceCode(event);
						else callbacks.onProgress?.(event.message);
					},
				});
			},
			async refreshToken(credentials: Credential, signal?: AbortSignal) {
				return modern.refresh(
					{
						...credentials,
						type: "oauth",
						access: credentials.access ?? "",
						refresh: credentials.refresh ?? "",
						expires: credentials.expires ?? 0,
					},
					signal ?? new AbortController().signal,
				);
			},
			getApiKey(credentials: Credential) {
				return credentials.access ?? "";
			},
		},
		models: runtime.getModels("openai-codex").map(aliasModel),
	};
}

const authPath = path.join(os.homedir(), ".pi", "agent", "auth.json");
const tokenUsagePath = path.join(
	os.homedir(),
	".pi",
	"agent",
	"codex-account-usage.json",
);
const usageUrl = "https://chatgpt.com/backend-api/wham/usage";
const cooldowns = new Map<string, number>();
const limitPattern =
	/429|rate[_ ]?limit|too many requests|usage[_ ]?limit|usage_not_included|quota|out of budget|available balance|billing hard limit|freeusagelimiterror|gousagelimiterror/i;

function isCodexProvider(provider: string): boolean {
	return (
		provider === "openai-codex" || /^openai-codex-account-\d+$/.test(provider)
	);
}

function accountNumber(provider: string): number {
	return Number(provider.match(/-account-(\d+)$/)?.[1] ?? 1);
}

async function readAccounts(): Promise<[string, Credential][]> {
	const content = await fs.readFile(authPath, "utf8");
	let auth: Record<string, Credential>;
	try {
		auth = JSON.parse(content) as Record<string, Credential>;
	} catch {
		throw new Error(`${authPath} 파일이 올바른 JSON이 아닙니다.`);
	}
	return Object.entries(auth)
		.filter(
			([provider, credential]) =>
				isCodexProvider(provider) && credential.type === "oauth",
		)
		.sort(([a], [b]) => accountNumber(a) - accountNumber(b));
}

function emailFromToken(token = ""): string {
	try {
		const [, payloadPart] = token.split(".");
		const payload = JSON.parse(
			Buffer.from(payloadPart, "base64url").toString(),
		);
		return (
			payload["https://api.openai.com/profile"]?.email ??
			payload.email ??
			"이메일 없음"
		);
	} catch {
		return "이메일 확인 불가";
	}
}

function remaining(window?: Window): number | undefined {
	return typeof window?.used_percent === "number"
		? Math.max(0, Math.round(100 - window.used_percent))
		: undefined;
}

function resetAt(window?: Window): number | undefined {
	if (!window?.reset_at) return undefined;
	return window.reset_at < 10_000_000_000
		? window.reset_at * 1000
		: window.reset_at;
}

function resetIn(window?: Window): string {
	const reset = resetAt(window);
	if (!reset) return "?";
	const minutes = Math.max(0, Math.ceil((reset - Date.now()) / 60_000));
	if (minutes < 60) return `${minutes}분`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}시간 ${minutes % 60}분`;
	return `${Math.floor(hours / 24)}일 ${hours % 24}시간`;
}

function formatResetDate(window?: Window): string {
	const ts = resetAt(window);
	if (!ts) return "?";
	const d = new Date(ts);
	const m = d.getMonth() + 1;
	const day = d.getDate();
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	return `${m}/${day} ${hh}:${mm}`;
}

function bar(value?: number): string {
	if (value === undefined) return "----------";
	const filled = Math.round(value / 10);
	return `${"█".repeat(filled)}${"░".repeat(10 - filled)}`;
}

function windowLabel(window: Window | undefined, fallback: string): string {
	const seconds = window?.limit_window_seconds;
	if (!seconds) return fallback;
	if (seconds % 604_800 === 0) return `${seconds / 604_800}주`;
	if (seconds % 86_400 === 0) return `${seconds / 86_400}일`;
	if (seconds % 3_600 === 0) return `${seconds / 3_600}시간`;
	return fallback;
}

function emptyTokenUsage(reset?: number): TokenUsage {
	return {
		resetAt: reset,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
		seen: [],
	};
}

async function readTokenUsage(): Promise<TokenUsageState> {
	try {
		return JSON.parse(
			await fs.readFile(tokenUsagePath, "utf8"),
		) as TokenUsageState;
	} catch {
		return {};
	}
}

async function writeTokenUsage(state: TokenUsageState): Promise<void> {
	const temporary = `${tokenUsagePath}.tmp`;
	await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
		mode: 0o600,
	});
	await fs.rename(temporary, tokenUsagePath);
}

function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
	if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
	return String(tokens);
}

async function fetchAccount(provider: string, credential: Credential) {
	const email = emailFromToken(credential.access);
	if (!credential.access) return { provider, email, error: "OAuth 토큰 없음" };
	try {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${credential.access}`,
			Accept: "application/json",
		};
		if (credential.accountId)
			headers["ChatGPT-Account-Id"] = credential.accountId;
		const response = await fetch(usageUrl, {
			headers,
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok)
			return { provider, email, error: `HTTP ${response.status}` };
		const body = (await response.json()) as UsageBody;
		return {
			provider,
			email,
			plan: body.plan_type,
			allowed: body.rate_limit?.allowed,
			primary: body.rate_limit?.primary_window,
			secondary: body.rate_limit?.secondary_window,
		};
	} catch (error) {
		return {
			provider,
			email,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

function row(
	account: Account,
	current: string | undefined,
	_usage: TokenUsage | undefined,
): string {
	const n = accountNumber(account.provider);
	const isCurrent = account.provider === current;
	const marker = isCurrent ? "●" : "○";
	if (account.error)
		return `${marker} ${n}번  ${account.email}  조회 실패: ${account.error}`;
	const pRem = remaining(account.primary);
	const sRem = remaining(account.secondary);
	const pTxt = pRem === undefined ? "?" : `${pRem}%`;
	const sTxt = sRem === undefined ? "?" : `${sRem}%`;
	const cur = isCurrent ? "  ← 현재" : "";
	// 5h:32% 형태로 콜론으로 구분해 겹쳐 보이는 문제 해결
	return `${marker} ${n}번  ${account.email}  5h:${pTxt} · 7d:${sTxt}${cur}`;
}

function detailRow(account: Account, usage: TokenUsage | undefined, current?: string): string {
	const isCurrent = account.provider === current;
	const marker = isCurrent ? "●" : "○";
	const curTag = isCurrent ? "  ← 현재 사용 중" : "";
	if (account.error) return `  ${marker} ${accountNumber(account.provider)}번  ${account.email}  오류: ${account.error}${curTag}`;
	const n = String(accountNumber(account.provider)).padStart(2, " ");
	const pLabel = windowLabel(account.primary, "5h");
	const sLabel = windowLabel(account.secondary, "7d");
	const pRem = remaining(account.primary);
	const sRem = remaining(account.secondary);
	const pPct = pRem === undefined ? "?" : `${String(pRem).padStart(3, " ")}% 남음`;
	const sPct = sRem === undefined ? "?" : `${String(sRem).padStart(3, " ")}% 남음`;
	const tokens = usage
		? `토큰 ${formatTokens(usage.total)} (캐시 ${formatTokens(usage.cacheRead)})`
		: "토큰 0";
	const pBar = `${bar(pRem)} [${pPct}]`;
	const sBar = `${bar(sRem)} [${sPct}]`;
	return [
		` ${marker}${n}번  ${account.email}  [${account.plan ?? "?"}]  ${tokens}${curTag}`,
		`     └ ${pLabel} ${pBar}  리셋 ${formatResetDate(account.primary)} (${resetIn(account.primary)} 후)  ·  ${sLabel} ${sBar}  리셋 ${formatResetDate(account.secondary)} (${resetIn(account.secondary)} 후)`,
	].join("\n");
}

function buildTable(accounts: Account[], tokenUsage: TokenUsageState, current?: string): string {
	const header = " Codex 계정별 남은 한도 (5시간 · 7일)";
	const lines = accounts.map((a) => detailRow(a, tokenUsage[a.provider], current));
	let curLine = "";
	if (current) {
		if (isCodexProvider(current)) {
			const curAcc = accounts.find((a) => a.provider === current);
			curLine = curAcc ? ` │ 현재: ${curAcc.email} (${accountNumber(current)}번) ●` : ` │ 현재: ${current}`;
		} else {
			curLine = ` │ 현재 모델: ${current} (Codex 아님)`;
		}
	} else {
		curLine = " │ 현재 모델 없음";
	}
	return [header + curLine, "─".repeat(72), ...lines].join("\n");
}

function aliasModel(model: ReturnType<ModelRuntime["getModels"]>[number]) {
	return {
		id: model.id,
		name: model.name,
		api: model.api,
		reasoning: model.reasoning,
		thinkingLevelMap: model.thinkingLevelMap,
		input: model.input,
		cost: model.cost,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		compat: model.compat,
	};
}

async function switchTo(
	provider: string,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
): Promise<boolean> {
	if (ctx.model?.provider === provider) return true;
	const preferredId = ctx.model?.id;
	const target = modelForAccount(
		provider,
		ctx.model,
		preferredId ? ctx.modelRegistry.find(provider, preferredId) : undefined,
		ctx.modelRegistry
			.getAvailable()
			.find((model) => model.provider === provider),
	);
	if (!target) {
		ctx.ui.notify(
			`${provider}에서 사용할 모델을 찾지 못했습니다. /reload 후 다시 시도하세요.`,
			"error",
		);
		return false;
	}
	return pi.setModel(target);
}

export default async function codexAccounts(pi: ExtensionAPI) {
	const { oauth: codexOAuth, models } = await createCodexConfig();
	const accounts = await readAccounts().catch(() => []);
	const highest = Math.max(
		1,
		...accounts.map(([provider]) => accountNumber(provider)),
	);
	const providers = new Set(accounts.map(([provider]) => provider));
	providers.add(`openai-codex-account-${highest + 1}`);

	for (const provider of providers) {
		if (provider === "openai-codex") continue;
		pi.registerProvider(provider, {
			name: `ChatGPT Plus/Pro (Codex ${provider})`,
			baseUrl: "https://chatgpt.com/backend-api",
			api: "openai-codex-responses",
			oauth: {
				...codexOAuth,
				name: `ChatGPT Plus/Pro (Codex ${provider})`,
			},
			models,
		});
	}

	pi.registerCommand("codex-accounts", {
		description: "Codex 계정별 한도를 보고 선택한 계정으로 전환",
		handler: async (_args, ctx) => {
			for (;;) {
				const entries = await readAccounts();
				const loaded = await Promise.all(
					entries.map(([provider, credential]) =>
						fetchAccount(provider, credential),
					),
				);
				const tokenUsage = await readTokenUsage();
				let usageChanged = false;
				for (const account of loaded) {
					if (account.error) continue;
					const reset = resetAt(account.primary);
					const saved = tokenUsage[account.provider];
					if (!saved) {
						tokenUsage[account.provider] = emptyTokenUsage(reset);
						usageChanged = true;
					} else if (reset && saved.resetAt && saved.resetAt !== reset) {
						tokenUsage[account.provider] = emptyTokenUsage(reset);
						usageChanged = true;
					} else if (reset && !saved.resetAt) {
						saved.resetAt = reset;
						usageChanged = true;
					}
				}
				if (usageChanged) await writeTokenUsage(tokenUsage);
				// 상세 표는 위젯으로 띄워 명령어 닫히면 자동 사라지게 함
				const table = buildTable(loaded, tokenUsage, ctx.model?.provider);
				ctx.ui.setWidget("codex-accounts-table", table.split("\n"), { placement: "aboveEditor" });
				const rows = loaded.map((account) =>
					row(account, ctx.model?.provider, tokenUsage[account.provider]),
				);
				const refresh = "↻ 새로고침";
				const close = "닫기";
				const choice = await ctx.ui.select("전환할 계정 선택 (상세는 위 표 참고)", [
					...rows,
					refresh,
					close,
				]);
				if (!choice || choice === close) {
					ctx.ui.setWidget("codex-accounts-table", undefined);
					return;
				}
				if (choice === refresh) continue;
				const selected = loaded[rows.indexOf(choice)];
				if (!selected || selected.provider === ctx.model?.provider) {
					ctx.ui.setWidget("codex-accounts-table", undefined);
					return;
				}
				if (await switchTo(selected.provider, ctx, pi)) {
					ctx.ui.setWidget("codex-accounts-table", undefined);
					ctx.ui.notify(`${selected.email} 계정으로 전환했습니다.`, "info");
					return;
				}
				ctx.ui.setWidget("codex-accounts-table", undefined);
			}
		},
	});

	let usageWrite = Promise.resolve();
	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		if (
			isCodexProvider(event.message.provider) &&
			event.message.usage.totalTokens > 0
		) {
			const message = event.message;
			// 여러 pi 프로세스가 같은 파일을 갱신하므로 read→write 전체를 프로세스 간 잠금으로 감싼다.
			// 한 번 실패해도 체인이 영구 거부 상태로 남지 않게 catch로 마무리한다.
			usageWrite = usageWrite
				.then(() =>
					withFileLock(tokenUsagePath, async () => {
						const state = await readTokenUsage();
						let usage = state[message.provider] ?? emptyTokenUsage();
						if (usage.resetAt && message.timestamp >= usage.resetAt)
							usage = emptyTokenUsage();
						const fingerprint = `${message.provider}:${message.timestamp}:${message.model}:${message.usage.totalTokens}`;
						if (usage.seen.includes(fingerprint)) return;
						usage.input += message.usage.input;
						usage.output += message.usage.output;
						usage.cacheRead += message.usage.cacheRead;
						usage.cacheWrite += message.usage.cacheWrite;
						usage.total += message.usage.totalTokens;
						usage.seen = [...usage.seen.slice(-999), fingerprint];
						state[message.provider] = usage;
						await writeTokenUsage(state);
					}),
				)
				.catch(() => {});
			await usageWrite;
		}
		if (event.message.stopReason !== "error") return;
		const error = event.message.errorMessage ?? "";
		const current = ctx.model?.provider;
		if (!current || !isCodexProvider(current) || !limitPattern.test(error))
			return;
		const entries = await readAccounts();
		const currentUsage = await fetchAccount(
			current,
			Object.fromEntries(entries)[current] ?? {},
		);
		const reset =
			"primary" in currentUsage
				? exhaustedResetAt(currentUsage.primary, currentUsage.secondary)
				: undefined;
		cooldowns.set(
			current,
			reset && reset > Date.now() ? reset : Date.now() + 60 * 60 * 1000,
		);
		const candidates = await Promise.all(
			entries.map(async ([provider, credential]) => ({
				provider,
				credential,
				usage: await fetchAccount(provider, credential),
			})),
		);
		const next = candidates.find(
			({ provider, usage }) =>
				provider !== current &&
				(cooldowns.get(provider) ?? 0) <= Date.now() &&
				isAccountAvailable(usage),
		);
		if (!next) {
			ctx.ui.notify(
				"모든 Codex 계정이 한도 소진 또는 대기 상태입니다.",
				"error",
			);
			return;
		}
		if (!(await switchTo(next.provider, ctx, pi))) return;
		// 자동 재개는 하지 않는다. 한도 오류를 받은 모든 세션이 동시에 다음 턴을 돌리면서
		// 새 계정 한도까지 연쇄 소진된 사고(2026-09-05)의 직접 원인이었다.
		ctx.ui.notify(
			`${emailFromToken(next.credential.access)} 계정으로 전환했습니다. 이어가려면 직전 요청을 다시 보내세요.`,
			"warning",
		);
	});
}
