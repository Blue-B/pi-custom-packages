import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { withFileLock } from "./lock.ts";

const run = promisify(execFile);
const usagePath = "/backend-api/wham/usage";
const appsPath = `${usagePath}/chatpass/apps`;
export const usagePage = "https://chatgpt.com/settings/usage";
export type UsageWindow = { used_percent?: number; limit_window_seconds?: number; reset_at?: number };
type UsageBody = {
	email?: string;
	rate_limit?: { primary_window?: UsageWindow | null; secondary_window?: UsageWindow | null };
};
type AppUsage = { items?: { id: string; windows?: UsageWindow[] }[] };
export type BrowserUsage = { email?: string; accountId?: string; source?: "codex" | "web"; plan: UsageWindow[]; app: UsageWindow[]; checkedAt?: number; error?: string };
type Entries = [string, { clientId?: string }][];
const cachePath = () => path.join(os.homedir(), ".pi", "agent", "openai-account-quota.json");

export function usageForClient(usage: UsageBody, apps: AppUsage, clientId: string): BrowserUsage | undefined {
	const app = apps.items?.find((item) => item.id === clientId);
	if (!app) return undefined; // Never associate a browser account by slot/order alone.
	return {
		email: usage.email,
		plan: [usage.rate_limit?.primary_window, usage.rate_limit?.secondary_window]
			.filter((window): window is UsageWindow => Boolean(window)),
		app: app.windows ?? [],
	};
}

export function remaining(window: UsageWindow): number | undefined {
	const used = window.used_percent;
	return typeof used === "number" && Number.isFinite(used)
		? Math.round(Math.max(0, Math.min(100, 100 - used))) : undefined;
}

export function windowLine(label: string, window: UsageWindow): string {
	const left = remaining(window);
	const seconds = window.limit_window_seconds;
	let period = "한도";
	if (seconds) period = seconds === 604800 ? "주간" : `${seconds / 3600}시간`;
	if (left === undefined) return `     └ ${label} ${period}: 수치 없음`;
	const filled = Math.round(left / 10);
	const reset = window.reset_at;
	let date: string | undefined;
	if (reset && Number.isFinite(reset)) {
		const milliseconds = reset < 10000000000 ? reset * 1000 : reset;
		date = new Date(milliseconds).toLocaleString("ko-KR", {
			month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
		});
	}
	return `     └ ${label} ${period} ${"█".repeat(filled)}${"░".repeat(10 - filled)} ${left}% 남음${date ? `  초기화 ${date}` : ""}`;
}

async function readCache(): Promise<Record<string, BrowserUsage>> {
	try { return JSON.parse(await fs.readFile(cachePath(), "utf8")); } catch { return {}; }
}

export async function readCachedUsage(entries: Entries): Promise<Record<string, BrowserUsage>> {
	const cache = await readCache();
	return Object.fromEntries(entries.flatMap(([provider, credential]) => {
		const saved = credential.clientId && cache[credential.clientId];
		return saved ? [[provider, saved]] : [];
	}));
}

async function saveUsage(entries: Entries, result: Record<string, BrowserUsage>): Promise<void> {
	if (!Object.keys(result).length) return;
	await withFileLock(cachePath(), async () => {
		const cache = await readCache();
		for (const [provider, credential] of entries) {
			if (!credential.clientId || !result[provider]) continue;
			const previous = cache[credential.clientId];
			cache[credential.clientId] = result[provider].error && previous
				? { ...previous, error: result[provider].error } : result[provider];
		}
		await fs.writeFile(cachePath(), `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
	});
}

// Only read Codex-owned credentials; never refresh them or change model OAuth.
// Discover new bindings from the server's exact app-client-ID match, not email/order.
export async function readCodexUsage(entries: Entries): Promise<Record<string, BrowserUsage>> {
	const saved = await readCachedUsage(entries);
	const homes = process.env.OPENAI_ACCOUNTS_CODEX_HOMES?.split(path.delimiter).filter(Boolean)
		?? [process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), path.join(os.homedir(), ".codex-account-2")];
	const credentials = await Promise.all(homes.map(async (home) => {
		try {
			const { tokens } = JSON.parse(await fs.readFile(path.join(home, "auth.json"), "utf8"));
			if (!tokens?.access_token || !tokens.account_id) return undefined;
			const [, payload] = tokens.access_token.split(".");
			const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
			if (claims["https://api.openai.com/auth"]?.chatgpt_account_id !== tokens.account_id) return undefined;
			return { access: tokens.access_token as string, accountId: tokens.account_id as string, home };
		} catch { return undefined; }
	}));
	const available = credentials.filter((item) => item !== undefined);
	const bindings = new Map<string, (typeof available)[number]>();
	for (const [provider] of entries) {
		const credential = available.find((item) => item.accountId === saved[provider]?.accountId);
		if (credential) bindings.set(provider, credential);
	}
	const unbound = entries.filter(([provider, credential]) =>
		!bindings.has(provider) && credential.clientId?.startsWith("oaiapp_"));
	const failures: string[] = [];
	if (unbound.length) {
		const discovered = await Promise.all(available.map(async (credential) => {
			try {
				const response = await fetch(`https://chatgpt.com${appsPath}`, {
					headers: { Accept: "application/json", Authorization: `Bearer ${credential.access}`, "ChatGPT-Account-Id": credential.accountId },
					redirect: "error", signal: AbortSignal.timeout(6000),
				});
				if (!response.ok) throw new Error(response.status === 401
					? `Codex 조회 인증 만료 또는 접근 거부. 인증 폴더: ${credential.home}`
					: `계정 연결 서버 HTTP ${response.status}`);
				const apps: AppUsage = await response.json();
				if (!Array.isArray(apps.items)) throw new Error("서버의 Pi 앱 목록 없음");
				return { credential, items: apps.items };
			} catch (error) {
				failures.push(error instanceof Error && !["TypeError", "TimeoutError", "SyntaxError"].includes(error.name)
					? error.message : "Codex 계정 연결 조회 실패 또는 시간 초과");
			}
		}));
		for (const [provider, credential] of unbound) {
			const matches = discovered.flatMap((item) =>
				item?.items.some((app) => app?.id === credential.clientId) ? [item.credential] : []);
			const accounts = new Set(matches.map((item) => item.accountId));
			if (accounts.size === 1 && matches[0]) bindings.set(provider, matches[0]);
			else if (accounts.size > 1) failures.push("Pi 앱이 여러 계정에서 확인됐습니다. 조회 인증 폴더를 확인하세요.");
		}
	}
	const result: Record<string, BrowserUsage> = Object.fromEntries(await Promise.all(entries.map(async ([provider]) => {
		const credential = bindings.get(provider);
		let quota: BrowserUsage = { plan: [], app: [] };
		if (!available.length) quota.error = "Codex 조회 인증 없음. README의 '한도 조회용 인증' 설정을 완료하세요.";
		else if (!credential) quota.error = failures.join(" / ") || "동일 계정의 Codex 조회 인증 없음. Pi와 Codex 로그인 계정이 같은지 확인하세요. README의 '한도 조회용 인증'을 참고하세요.";
		else {
			const accountId = credential.accountId;
			try {
				const response = await fetch(`https://chatgpt.com${usagePath}`, {
					headers: { Accept: "application/json", Authorization: `Bearer ${credential.access}`, "ChatGPT-Account-Id": accountId },
					redirect: "error", signal: AbortSignal.timeout(6000),
				});
				if (!response.ok) throw new Error(response.status === 401
					? `Codex 조회 인증 만료 또는 접근 거부. 인증 폴더: ${credential.home}. README의 '인증 갱신'을 참고하세요.`
					: `한도 서버 HTTP ${response.status}`);
				const body: UsageBody = await response.json();
				const plan = [body.rate_limit?.primary_window, body.rate_limit?.secondary_window]
					.filter((window): window is UsageWindow => Boolean(window));
				if (!plan.length || plan.some((window) => remaining(window) === undefined)) throw new Error("서버의 플랜 한도 수치 없음");
				quota = { email: body.email || saved[provider]?.email, accountId, source: "codex", plan, app: [], checkedAt: Date.now() };
			} catch (error) {
				quota.error = error instanceof Error && !["TypeError", "TimeoutError", "SyntaxError"].includes(error.name)
					? error.message : "Codex 한도 조회 실패 또는 시간 초과";
			}
		}
		return [provider, quota] as const;
	})));
	try { await saveUsage(entries, result); } catch {
		for (const quota of Object.values(result)) quota.error = [quota.error, "최근 한도 결과 저장 실패"].filter(Boolean).join(" / ");
	}
	return result;
}

// Keep the web token only in request-local memory. Persist quota numbers, never
// browser headers/tokens. Model OAuth grants and request routing are untouched.
export async function readBrowserUsage(entries: Entries): Promise<Record<string, BrowserUsage>> {
	const clients = entries.filter(([, credential]) => credential.clientId?.startsWith("oaiapp_"));
	if (!clients.length) return {};
	const profiles = (process.env.OPENAI_ACCOUNTS_USAGE_PROFILES ?? "main,work").split(",").map((p) => p.trim()).filter(Boolean);
	const result: Record<string, BrowserUsage> = {};
	const failures: string[] = [];
	await Promise.all(profiles.map(async (profile) => {
		const env = { ...process.env, AB_PROFILE: profile, AB_SESSION: `${process.pid}-usage` };
		async function ab(...args: string[]) {
			try {
				const { stdout } = await run("ab", ["--json", ...args], { env, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
				const response = JSON.parse(stdout);
				if (!response.success) throw new Error("Browser unavailable");
				return response.data;
			} catch { throw new Error(`${profile}: 브라우저 연결 실패 (${args[0]})`); }
		}
		async function webHeaders(navigate = false): Promise<Record<string, string>> {
			if (navigate) {
				await ab("open", "about:blank");
				await ab("network", "requests", "--clear");
				await ab("open", usagePage);
				await ab("wait", "--fn", "document.body.innerText.includes('앱 사용 한도') || document.body.innerText.includes('App usage limits') || document.body.innerText.includes('무료로 회원 가입') || document.body.innerText.includes('Sign up')");
			}
			const { requests } = await ab("network", "requests", "--filter", "wham/usage", "--type", "xhr,fetch");
			const request = requests.findLast((r: { url: string; status?: number }) => r.url.split("?")[0] === `https://chatgpt.com${usagePath}` && r.status === 200);
			if (!request) {
				if (!navigate) return webHeaders(true);
				const { result: loggedOut } = await ab("eval", "document.body.innerText.includes('무료로 회원 가입') || document.body.innerText.includes('Sign up')");
				throw new Error(`${profile}: ${loggedOut ? "ChatGPT 웹 로그인 필요" : "사용량 페이지 응답 없음"}`);
			}
			const { headers } = await ab("network", "request", request.requestId);
			const safe: Record<string, string> = { Accept: "application/json" };
			for (const [key, value] of Object.entries(headers ?? {}))
				if (["authorization", "chatgpt-account-id"].includes(key.toLowerCase()) && typeof value === "string") safe[key.toLowerCase()] = value;
			if (!safe.authorization || !safe["chatgpt-account-id"]) throw new Error(`${profile}: 웹 인증 정보 확인 실패`);
			return safe;
		}
		try {
			let headers = await webHeaders();
			async function getUsage() {
				return Promise.all([usagePath, appsPath].map((pathname) => fetch(`https://chatgpt.com${pathname}`, {
					headers, redirect: "error", signal: AbortSignal.timeout(6000),
				})));
			}
			let responses = await getUsage();
			if (responses.some((r) => r.status === 401)) {
				headers = await webHeaders(true);
				responses = await getUsage();
			}
			for (const response of responses) if (!response.ok) throw new Error(`${profile}: 한도 서버 HTTP ${response.status}`);
			const [usage, apps] = await Promise.all(responses.map((response) => response.json()));
			for (const [provider, credential] of clients) {
				if (!credential.clientId) continue;
				const matched = usageForClient(usage, apps, credential.clientId);
				if (matched) {
					if (!matched.plan.length || matched.plan.some((window) => remaining(window) === undefined))
						throw new Error(`${profile}: 서버의 플랜 한도 수치 없음`);
					result[provider] = { ...matched, accountId: headers["chatgpt-account-id"], source: "web", checkedAt: Date.now() };
				}
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : "조회 실패";
			failures.push(message.startsWith(`${profile}:`) ? message : `${profile}: 한도 조회 실패 또는 시간 초과`);
		}
	}));
	for (const [provider] of clients) if (!result[provider])
		result[provider] = { plan: [], app: [], checkedAt: Date.now(), error: failures.join(" / ") || "웹 계정의 Pi 앱 ID가 이 로그인과 일치하지 않습니다." };
	try { await saveUsage(clients, result); } catch {
		for (const quota of Object.values(result)) quota.error = [quota.error, "최근 한도 결과 저장 실패"].filter(Boolean).join(" / ");
	}
	return result;
}
