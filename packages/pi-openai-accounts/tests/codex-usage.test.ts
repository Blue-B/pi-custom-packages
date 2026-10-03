import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import { readCodexUsage, readCachedUsage, remaining } from "../extensions/openai-accounts/usage.ts";

const token = (accountId: string) => `header.${Buffer.from(JSON.stringify({
	"https://api.openai.com/auth": { chatgpt_account_id: accountId },
})).toString("base64url")}.signature`;

test("Codex quota is account-bound, read-only, plan-only and preserves last good values", async () => {
	const home = await fs.mkdtemp(path.join(os.tmpdir(), "openai-codex-usage-"));
	const previous = { HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME,
		OPENAI_ACCOUNTS_CODEX_HOMES: process.env.OPENAI_ACCOUNTS_CODEX_HOMES };
	const agentDir = path.join(home, ".pi", "agent");
	const codexDir = path.join(home, ".codex");
	await fs.mkdir(agentDir, { recursive: true });
	await fs.mkdir(codexDir);
	const cachePath = path.join(agentDir, "openai-account-quota.json");
	const nativePath = path.join(codexDir, "auth.json");
	const modelPath = path.join(agentDir, "auth.json");
	const nativeAuth = JSON.stringify({ tokens: { access_token: token("account-one"),
		account_id: "account-one", refresh_token: "must-not-refresh" } });
	const modelAuth = JSON.stringify({ openai: { access: "direct-must-not-be-used" } });
	await fs.writeFile(nativePath, nativeAuth);
	await fs.writeFile(modelPath, modelAuth);
	await fs.writeFile(cachePath, JSON.stringify({
		clientOne: { accountId: "account-one", email: "same@example.com", source: "web", checkedAt: 1000,
			plan: [{ used_percent: 74, limit_window_seconds: 604800 }], app: [{ used_percent: 1 }] },
		clientTwo: { accountId: "account-two", email: "same@example.com", checkedAt: 2000,
			plan: [{ used_percent: 20, limit_window_seconds: 18000 }], app: [] },
	}), { mode: 0o600 });
	const entries: [string, { clientId: string }][] = [["openai", { clientId: "clientOne" }],
		["openai-account-2", { clientId: "clientTwo" }]];
	try {
		process.env.HOME = home;
		delete process.env.CODEX_HOME;
		delete process.env.OPENAI_ACCOUNTS_CODEX_HOMES;
		let status = 200;
		let body: object = { email: "same@example.com", rate_limit: {
			primary_window: { used_percent: 30, limit_window_seconds: 18000, reset_at: 1800000000 },
			secondary_window: { used_percent: 74, limit_window_seconds: 604800, reset_at: 1800600000 },
		} };
		let requests = 0;
		mock.method(globalThis, "fetch", async (url: string, options: any) => {
			requests++;
			assert.equal(url, "https://chatgpt.com/backend-api/wham/usage");
			assert.equal(options.headers.Authorization, `Bearer ${token(options.headers["ChatGPT-Account-Id"])}`);
			assert.equal(options.body, undefined);
			assert.equal(options.redirect, "error");
			return new Response(JSON.stringify(body), { status });
		});
		const quota = await readCodexUsage(entries);
		assert.equal(requests, 1, "same email must not associate the other account");
		assert.equal(remaining(quota.openai.plan[0]), 70);
		assert.equal(remaining(quota.openai.plan[1]), 26);
		assert.deepEqual(quota.openai.app, []);
		assert.equal(quota.openai.source, "codex");
		assert.match(quota["openai-account-2"].error!, /동일 계정.*인증 없음/);
		let cached = await readCachedUsage(entries);
		assert.equal(cached["openai-account-2"].checkedAt, 2000);
		assert.equal(remaining(cached["openai-account-2"].plan[0]), 80);
		const lastSuccess = cached.openai.checkedAt;
		status = 401;
		assert.match((await readCodexUsage(entries)).openai.error!, /인증 만료 또는 접근 거부/);
		cached = await readCachedUsage(entries);
		assert.equal(cached.openai.checkedAt, lastSuccess);
		assert.equal(remaining(cached.openai.plan[0]), 70);
		status = 503;
		assert.match((await readCodexUsage(entries)).openai.error!, /HTTP 503/);
		status = 200;
		body = { rate_limit: { primary_window: { limit_window_seconds: 604800 } } };
		assert.match((await readCodexUsage(entries)).openai.error!, /수치 없음/);
		body = { rate_limit: { primary_window: { used_percent: 12, limit_window_seconds: 604800 } } };
		assert.equal((await readCodexUsage(entries)).openai.plan.length, 1, "never invent a missing 5-hour window");
		assert.equal((await readCachedUsage(entries)).openai.error, undefined);

		const callsBefore = requests;
		await readCodexUsage([["openai", { clientId: "newClient" }]]);
		assert.equal(requests, callsBefore, "new OAuth client IDs require a verified binding");
		await fs.writeFile(nativePath, JSON.stringify({ tokens: { access_token: token("account-two"), account_id: "account-one" } }));
		assert.match((await readCodexUsage(entries)).openai.error!, /인증 없음/);
		assert.equal(requests, callsBefore, "mismatched token and account header must not be sent");
		await fs.writeFile(nativePath, nativeAuth);

		const secondHome = path.join(home, "codex-two");
		await fs.mkdir(secondHome);
		await fs.writeFile(path.join(secondHome, "auth.json"), JSON.stringify({ tokens: {
			access_token: token("account-two"), account_id: "account-two",
		} }));
		process.env.OPENAI_ACCOUNTS_CODEX_HOMES = [codexDir, secondHome].join(path.delimiter);
		const both = await readCodexUsage(entries);
		assert.equal(both.openai.error, undefined);
		assert.equal(both["openai-account-2"].error, undefined);
		assert.equal(requests, callsBefore + 2);
		assert.equal(await fs.readFile(nativePath, "utf8"), nativeAuth);
		assert.equal(await fs.readFile(modelPath, "utf8"), modelAuth);
		const cacheText = await fs.readFile(cachePath, "utf8");
		assert.equal(/signature|must-not-refresh|direct-must-not-be-used|Authorization/.test(cacheText), false);
		assert.equal((await fs.stat(cachePath)).mode & 0o777, 0o600);
	} finally {
		mock.restoreAll();
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		await fs.rm(home, { recursive: true, force: true });
	}
});
