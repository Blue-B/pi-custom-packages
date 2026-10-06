import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/compat";
import type { Api, Model, ProviderRequestOptions } from "@earendil-works/pi-ai";
import {
	ModelRuntime,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { withFileLock } from "./lock.ts";
import { accountToKeep, CODEX_ACCOUNT, isAccountProvider, modelForAccount } from "./model.ts";
import { readBrowserUsage, readCodexUsage, readCachedUsage, remaining, windowLine, type BrowserUsage } from "./usage.ts";

type Credential = { type?: string; access?: string; clientId?: string };
type TokenUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
	seen: string[];
};
type TokenUsageState = Record<string, TokenUsage>;
const authPath = path.join(os.homedir(), ".pi", "agent", "auth.json");
// Keep the existing file so recorded usage is not lost during the migration.
const tokenUsagePath = path.join(os.homedir(), ".pi", "agent", "codex-account-usage.json");
const cooldowns = new Map<string, number>();
const limitPattern =
	/429|rate[_ ]?limit|too many requests|usage[_ ]?limit|usage_not_included|quota|out of budget|available balance|billing hard limit|freeusagelimiterror|gousagelimiterror/i;

function accountNumber(provider: string): number {
	return provider === "openai" ? 1 : provider === CODEX_ACCOUNT ? 3 : 2;
}

async function readAccounts(): Promise<[string, Credential][]> {
	let content: string;
	try {
		content = await fs.readFile(authPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	let auth: Record<string, Credential>;
	try {
		auth = JSON.parse(content);
	} catch {
		throw new Error(`${authPath} 파일이 올바른 JSON이 아닙니다.`);
	}
	return Object.entries(auth)
		.filter(([provider, credential]) =>
			isAccountProvider(provider) && credential?.type === "oauth" && Boolean(credential.access))
		.sort(([a], [b]) => accountNumber(a) - accountNumber(b));
}

function accountLabelFromToken(token = ""): string {
	try {
		const [, payloadPart] = token.split(".");
		const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString());
		return payload["https://api.openai.com/profile"]?.email || payload.email || "ChatGPT 로그인됨";
	} catch {
		return "ChatGPT 로그인됨";
	}
}

async function readTokenUsage(): Promise<TokenUsageState> {
	try {
		return JSON.parse(await fs.readFile(tokenUsagePath, "utf8"));
	} catch {
		return {};
	}
}

async function writeTokenUsage(state: TokenUsageState): Promise<void> {
	const temporary = `${tokenUsagePath}.tmp`;
	await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
	await fs.rename(temporary, tokenUsagePath);
}

function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
	if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
	return String(tokens);
}

function accountRow(provider: string, credential: Credential, current?: string, email?: string): string {
	return `${provider === current ? "●" : "○"} ${accountNumber(provider)}번  ${email || accountLabelFromToken(credential.access)}${provider === current ? "  ← 현재" : ""}`;
}

// Accounts that hit a limit during the current user request. Persisted in the session, so reloads cannot loop.
function limitedSinceLastUser(ctx: ExtensionContext): Set<string> {
	const limited = new Set<string>();
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "user") limited.clear();
		else if (
			message.role === "assistant" && message.stopReason === "error" &&
			isAccountProvider(message.provider) && limitPattern.test(message.errorMessage ?? "")
		) limited.add(message.provider);
	}
	return limited;
}

async function switchTo(provider: string, ctx: ExtensionContext, pi: ExtensionAPI): Promise<boolean> {
	if (ctx.model?.provider === provider) return true;
	const target = modelForAccount(
		provider,
		ctx.model,
		ctx.model ? ctx.modelRegistry.find(provider, ctx.model.id) : undefined,
		ctx.modelRegistry.find(provider, "gpt-6.1-sol"),
	);
	if (!target) {
		ctx.ui.notify(`${provider}에서 사용할 ChatGPT 모델을 찾지 못했습니다.`, "error");
		return false;
	}
	return pi.setModel(target);
}

// Keep this request-local: stored tool calls/results must retain their matching IDs.
function requestOptions<T extends ProviderRequestOptions>(options?: T, subscriptionAlias = false) {
	return {
		...options,
		onPayload: async (payload: unknown, model: Model<Api>) => {
			const request = { ...((await options?.onPayload?.(payload, model)) ?? payload) as Record<string, unknown> };
			// Pi 0.99.2 can normalize replayed grammar-tool item IDs to fc_*.
			// Custom calls require ctc_*; omit invalid item IDs rather than inventing one.
			if (Array.isArray(request.input)) {
				request.input = request.input.map((item) => {
					if (item?.type !== "custom_tool_call" || typeof item.id !== "string" || item.id.startsWith("ctc_")) return item;
					const { id: _id, ...call } = item;
					return call;
				});
			}
			// Pi only detects subscription requests for the literal "openai" provider.
			if (subscriptionAlias) {
				for (const field of ["max_output_tokens", "temperature", "prompt_cache_retention", "prompt_cache_options"])
					delete request[field];
			}
			return request;
		},
	};
}

export default async function openaiAccounts(pi: ExtensionAPI) {
	const runtime = await ModelRuntime.create();
	const official = runtime.getProvider("openai");
	if (!official?.auth.oauth) throw new Error("OpenAI ChatGPT OAuth provider unavailable (Pi 0.99.2 이상 필요)");
	pi.registerProvider({
		...official,
		stream: (model, context, options) => official.stream<Api>(model, context, requestOptions(options)),
		streamSimple: (model, context, options) => official.streamSimple(model, context, requestOptions(options)),
	});
	const id = "openai-account-2";
	// Native OAuth owns deviceId, issued clientId/scopes, refresh and API routing.
	pi.registerProvider({
		...official,
		id,
		name: "OpenAI (ChatGPT 2번 계정)",
		auth: { oauth: official.auth.oauth },
		getModels: () => official.getModels().map((m) => ({ ...m, provider: id })),
		getAllModels: () => (official.getAllModels?.() ?? official.getModels()).map((m) => ({ ...m, provider: id })),
		stream: (model, context, options) => official.stream<Api>(model, context, requestOptions(options, true)),
		streamSimple: (model, context, options) => official.streamSimple(model, context, requestOptions(options, true)),
	});
	// Legacy Codex OAuth works while Subscription Sharing is broken (openai/codex#51043). Same email as account 1 is fine.
	const codex = runtime.getProvider("openai-codex");
	if (codex?.auth.oauth) pi.registerProvider({
		...codex,
		id: CODEX_ACCOUNT,
		name: "OpenAI Codex (3번 계정, 옛 방식)",
		auth: { oauth: codex.auth.oauth },
		getModels: () => codex.getModels().map((m) => ({ ...m, provider: CODEX_ACCOUNT })),
		getAllModels: () => (codex.getAllModels?.() ?? codex.getModels()).map((m) => ({ ...m, provider: CODEX_ACCOUNT })),
		stream: (model, context, options) => codex.stream<Api>(model, context, requestOptions(options)),
		streamSimple: (model, context, options) => codex.streamSimple(model, context, requestOptions(options)),
	});

	let switchingAccount = false;
	async function switchAccount(provider: string, ctx: ExtensionContext) {
		switchingAccount = true;
		try {
			return (await switchTo(provider, ctx, pi)) && ctx.model?.provider === provider;
		} finally {
			switchingAccount = false;
		}
	}

	const quotaLookups: Partial<Record<"codex" | "web", Promise<Record<string, BrowserUsage>>>> = {};
	const accountCommand = {
		description: "ChatGPT 구독 계정을 확인하고 전환",
		handler: async (args: string, ctx: ExtensionContext) => {
			const source = args.trim() === "web" ? "web" : "codex";
			try {
				for (;;) {
					const entries = await readAccounts();
					if (!entries.length) {
						ctx.ui.notify("/login openai, /login openai-account-2, /login openai-account-3에서 ChatGPT로 로그인하세요.", "info");
						return;
					}
					const usage = await readTokenUsage();
					let quotas = await readCachedUsage(entries);
					const rows = entries.map(([provider, credential]) => {
						const quota = quotas[provider];
						const weekly = quota?.plan.find((window) => window.limit_window_seconds === 604800);
						const left = weekly && remaining(weekly);
						return accountRow(provider, credential, ctx.model?.provider, quota?.email)
							+ (left !== undefined ? `  이전 조회 주간 ${left}% 남음` : "");
					});
					const renderQuotas = (updating: boolean) => {
						const lines = entries.flatMap(([provider, credential]) => {
							const quota = quotas[provider];
							const wait = Math.max(0, Math.ceil(((cooldowns.get(provider) ?? 0) - Date.now()) / 60_000));
							return [
								` ${accountRow(provider, credential, ctx.model?.provider, quota?.email)}  누적 토큰 ${formatTokens(usage[provider]?.total ?? 0)}`,
								...(quota?.error ? [`     └ 현재 한도 확인 불가: ${quota.error}`]
									: updating ? ["     └ 현재 한도 갱신 중"] : []),
								...(quota?.plan.length ? [
									...quota.plan.map((window) => windowLine(quota.error || updating ? "이전 조회 플랜" : "플랜", window)),
									`     └ 마지막 조회 ${new Date(quota.checkedAt ?? 0).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}${quota.source ? ` (${quota.source === "codex" ? "Codex" : "웹"} 조회)` : ""}${updating ? " (갱신 중)" : ""}`,
								] : [`     └ ${quota?.error || (updating ? "한도 조회 중 (계정 전환은 바로 가능)" : "아직 조회된 한도 없음")}`]),
								...(wait ? [`     └ 자동 전환 대기 ${wait}분`] : []),
							];
						});
						ctx.ui.setWidget("codex-accounts-table", [
							` ChatGPT 구독 계정 │ 로그인 ${entries.length}/3개 │ 현재: ${ctx.model?.provider ?? "모델 없음"}`,
							...lines,
						], { placement: "aboveEditor" });
					};
					let menuOpen = true;
					renderQuotas(true);
					const lookup = quotaLookups[source] ??= (source === "web" ? readBrowserUsage(entries) : readCodexUsage(entries))
						.finally(() => { delete quotaLookups[source]; });
					void lookup.then((updated) => {
						for (const [provider, quota] of Object.entries(updated)) {
							quotas[provider] = quota.error && quotas[provider]
								? { ...quotas[provider], error: quota.error } : quota;
						}
						if (menuOpen) renderQuotas(false);
					}).catch(() => {
						for (const [provider] of entries) quotas[provider] = {
							...(quotas[provider] ?? { plan: [], app: [] }), error: "한도 조회 실패. 새로고침으로 다시 시도하세요.",
						};
						if (menuOpen) renderQuotas(false);
					});
					const refresh = "새로고침", close = "닫기";
					let choice: string | undefined;
					try {
						choice = await ctx.ui.select(`ChatGPT 로그인 ${entries.length}/3개: 전환할 계정 선택 (한도는 위 표)`, [...rows, refresh, close]);
					} finally { menuOpen = false; }
					if (!choice || choice === close) return;
					if (choice === refresh) continue;
					const selected = entries[rows.indexOf(choice)];
					if (!selected || selected[0] === ctx.model?.provider) return;
					if (await switchAccount(selected[0], ctx)) {
						ctx.ui.notify(`${accountNumber(selected[0])}번 계정으로 전환했습니다. 모델: ${ctx.model?.id}`, "info");
						return;
					}
				}
			} finally {
				ctx.ui.setWidget("codex-accounts-table", undefined);
			}
		},
	};
	pi.registerCommand("openai-accounts", accountCommand);

	pi.on("model_select", async (event, ctx) => {
		if (switchingAccount) return;
		const keep = accountToKeep(event.previousModel?.provider, event.model.provider);
		if (!keep) return;
		// Use the kept account's own model: account 3 needs the Codex API/baseUrl, not a relabeled openai model.
		const target = modelForAccount(keep, event.model, ctx.modelRegistry.find(keep, event.model.id));
		if (target) await pi.setModel(target);
		else ctx.ui.notify(`${keep}에는 ${event.model.id} 모델이 없어 1번 계정으로 바뀌었습니다.`, "warning");
	});

	let usageWrite = Promise.resolve();
	let revision = 0;
	let pendingRetry:
		| {
				message: object;
				sessionId: string;
				model: ExtensionContext["model"];
				signal: AbortSignal | undefined;
				revision: number;
		  }
		| undefined;
	const invalidateRetry = () => {
		revision++;
		pendingRetry = undefined;
	};
	pi.on("input", invalidateRetry);
	pi.on("message_start", invalidateRetry);
	pi.on("session_before_switch", invalidateRetry);
	pi.on("session_before_tree", invalidateRetry);
	pi.on("session_shutdown", invalidateRetry);

	pi.on("agent_settled", (_event, ctx) => {
		const retry = pendingRetry;
		pendingRetry = undefined;
		if (
			!retry || retry.revision !== revision || retry.signal?.aborted ||
			!ctx.isIdle() || ctx.hasPendingMessages() || ctx.model !== retry.model ||
			ctx.sessionManager.getSessionId() !== retry.sessionId
		) return;
		const leaf = ctx.sessionManager.getBranch().at(-1);
		if (
			leaf?.type !== "message" ||
			leaf.message !== retry.message || leaf.message.role !== "assistant" ||
			leaf.message.stopReason !== "error"
		) return;
		pi.sendMessage({
			customType: "codex-account-retry",
			display: true,
			details: { failedMessageId: leaf.id },
			content: "계정 전환이 완료됐습니다. 바로 앞 한도 오류로 중단된 현재 응답만 이어가세요. 이미 완료한 일이나 과거 대화의 작업을 다시 시작하지 마세요.",
		}, { triggerTurn: true });
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const failedSessionId = ctx.sessionManager.getSessionId();
		const failedLeafId = ctx.sessionManager.getLeafId();
		const failedModel = ctx.model;
		const failedSignal = ctx.signal;
		const failedRevision = revision;
		const stillCurrent = () =>
			revision === failedRevision && !failedSignal?.aborted &&
			ctx.sessionManager.getSessionId() === failedSessionId &&
			ctx.sessionManager.getLeafId() === failedLeafId && ctx.model === failedModel &&
			!ctx.hasPendingMessages();
		if (isAccountProvider(event.message.provider) && event.message.usage.totalTokens > 0) {
			const message = event.message;
			usageWrite = usageWrite.then(() => withFileLock(tokenUsagePath, async () => {
				const state = await readTokenUsage();
				const usage = state[message.provider] ?? {
					input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, seen: [],
				};
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
			})).catch(() => {
				ctx.ui.notify("계정 사용량 기록에 실패했습니다. 누적 토큰 표시가 실제 사용량보다 적을 수 있습니다.", "warning");
			});
			await usageWrite;
		}
		if (event.message.stopReason !== "error") return;
		const current = ctx.model?.provider;
		if (
			!current || event.message.provider !== current || !isAccountProvider(current) ||
			!limitPattern.test(event.message.errorMessage ?? "") || !stillCurrent()
		) return;
		const entries = await readAccounts();
		// This failure is persisted only after message_end handlers run.
		const limited = limitedSinceLastUser(ctx).add(current);
		// ponytail: reset time is unknown; use a process-local 1h cooldown until a supported quota API exists.
		cooldowns.set(current, Date.now() + 60 * 60 * 1000);
		const next = entries.find(([provider]) =>
			!limited.has(provider) && (cooldowns.get(provider) ?? 0) <= Date.now());
		if (!next) {
			ctx.ui.notify("모든 ChatGPT 계정이 한도에 걸렸습니다. 한도가 초기화된 뒤 다시 요청하세요.", "error");
			return;
		}
		if (!stillCurrent() || !(await switchAccount(next[0], ctx))) return;
		if (
			!isRetryableAssistantError(event.message) && revision === failedRevision &&
			!failedSignal?.aborted && ctx.sessionManager.getSessionId() === failedSessionId &&
			!ctx.hasPendingMessages()
		) {
			pendingRetry = {
				message: event.message, sessionId: failedSessionId, model: ctx.model,
				signal: failedSignal, revision,
			};
		}
		ctx.ui.notify(`${accountNumber(next[0])}번 계정으로 전환했습니다. 같은 오류로 멈춰 있으면 현재 응답만 자동으로 이어갑니다.`, "warning");
	});
}
