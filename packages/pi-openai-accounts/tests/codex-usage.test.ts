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

		const secondHome = path.join(home, ".codex-account-2");
		await fs.mkdir(secondHome);
		await fs.writeFile(path.join(secondHome, "auth.json"), JSON.stringify({ tokens: {
			access_token: token("account-two"), account_id: "account-two",
		} }));
		const both = await readCodexUsage(entries);
		assert.equal(both.openai.error, undefined);
		assert.equal(both["openai-account-2"].error, undefined);
		assert.equal(requests, callsBefore + 2);
		process.env.OPENAI_ACCOUNTS_CODEX_HOMES = codexDir;
		assert.match((await readCodexUsage(entries))["openai-account-2"].error!, /인증 없음/,
			"an explicit homes setting must override the default second account home");
		assert.equal(requests, callsBefore + 3);
		process.env.OPENAI_ACCOUNTS_CODEX_HOMES = [codexDir, secondHome].join(path.delimiter);
		assert.equal((await readCodexUsage(entries))["openai-account-2"].error, undefined);
		assert.equal(requests, callsBefore + 5);
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

test("fresh users bind both accounts without a cache, browser, email or folder-order assumptions", async () => {
	const home = await fs.mkdtemp(path.join(os.tmpdir(), "openai-new-user-"));
	const previous = { HOME: process.env.HOME, PATH: process.env.PATH, CODEX_HOME: process.env.CODEX_HOME,
		OPENAI_ACCOUNTS_CODEX_HOMES: process.env.OPENAI_ACCOUNTS_CODEX_HOMES };
	const agentDir = path.join(home, ".pi", "agent");
	await fs.mkdir(agentDir, { recursive: true });
	const modelPath = path.join(agentDir, "auth.json");
	const modelAuth = JSON.stringify({ openai: { access: "model-token-must-not-be-used" } });
	await fs.writeFile(modelPath, modelAuth);
	const marker = path.join(home, "browser-called");
	await fs.writeFile(path.join(home, "ab"), `#!/bin/sh\ntouch "${marker}"\nexit 1\n`, { mode: 0o700 });
	const entries: [string, { clientId: string }][] = [["openai", { clientId: "oaiapp_one" }],
		["openai-account-2", { clientId: "oaiapp_two" }]];
	const files: [string, string][] = [];
	try {
		process.env.HOME = home;
		process.env.PATH = `${home}${path.delimiter}${previous.PATH}`;
		delete process.env.CODEX_HOME;
		delete process.env.OPENAI_ACCOUNTS_CODEX_HOMES;
		let appStatus = 200;
		let planStatus = 200;
		let firstClient = "oaiapp_one";
		let ambiguous = false;
		const requests: string[] = [];
		mock.method(globalThis, "fetch", async (url: string, options: any) => {
			const account = options.headers["ChatGPT-Account-Id"];
			assert.equal(options.headers.Authorization, `Bearer ${token(account)}`);
			assert.equal(options.body, undefined);
			assert.equal(options.redirect, "error");
			requests.push(url);
			const apps = url.endsWith("/chatpass/apps");
			assert.ok(apps || url === "https://chatgpt.com/backend-api/wham/usage");
			return new Response(JSON.stringify(apps
				? { items: [null, { id: account === "account-one" ? firstClient : "oaiapp_two" },
					...(ambiguous && account === "account-two" ? [{ id: firstClient }] : [])] }
				: { email: "same@example.com", rate_limit: {
					primary_window: { used_percent: account === "account-one" ? 10 : 50, limit_window_seconds: 18000 },
				} }), { status: apps ? appStatus : planStatus });
		});
		const missing = await readCodexUsage(entries);
		assert.match(missing.openai.error!, /조회 인증 없음.*한도 조회용 인증/);
		assert.equal(requests.length, 0);
		// Deliberately swap folder order. Only the server app ID determines the account.
		for (const [folder, account] of [[".codex", "account-two"], [".codex-account-2", "account-one"]]) {
			const dir = path.join(home, folder);
			await fs.mkdir(dir);
			const text = JSON.stringify({ tokens: { access_token: token(account), account_id: account, refresh_token: "must-not-refresh" } });
			const file = path.join(dir, "auth.json");
			await fs.writeFile(file, text);
			files.push([file, text]);
		}
		// Missing-auth errors contain no binding; the next ordinary refresh must recover.
		const fresh = await readCodexUsage(entries);
		assert.equal(fresh.openai.accountId, "account-one");
		assert.equal(fresh["openai-account-2"].accountId, "account-two");
		assert.equal(remaining(fresh.openai.plan[0]), 90);
		assert.equal(remaining(fresh["openai-account-2"].plan[0]), 50);
		assert.equal(fresh.openai.error, undefined);
		assert.equal(fresh["openai-account-2"].error, undefined);
		assert.equal(requests.filter((url) => url.endsWith("/apps")).length, 2);
		assert.equal(requests.length, 4);
		requests.length = 0;
		await readCodexUsage(entries);
		assert.equal(requests.length, 2, "verified cached bindings need only the plan requests");
		assert.ok(requests.every((url) => !url.endsWith("/apps")));

		firstClient = "oaiapp_relogged";
		const relogged: [string, { clientId: string }][] = [["openai", { clientId: firstClient }]];
		assert.equal((await readCodexUsage(relogged)).openai.accountId, "account-one", "new Pi grants bind without a web setup step");
		const cached = await readCachedUsage(relogged);
		planStatus = 401;
		assert.match((await readCodexUsage(relogged)).openai.error!, /인증 만료.*인증 폴더/);
		assert.equal((await readCachedUsage(relogged)).openai.checkedAt, cached.openai.checkedAt);
		planStatus = 200;
		assert.equal((await readCodexUsage(relogged)).openai.error, undefined);

		const unrecognized: [string, { clientId: string }][] = [["openai", { clientId: "oaiapp_unrecognized" }]];
		requests.length = 0;
		assert.match((await readCodexUsage(unrecognized)).openai.error!, /Pi와 Codex 로그인 계정/);
		assert.ok(requests.every((url) => url.endsWith("/apps")), "never query a guessed account's plan");
		appStatus = 401;
		assert.match((await readCodexUsage(unrecognized)).openai.error!, /인증 만료/);
		appStatus = 503;
		assert.match((await readCodexUsage(unrecognized)).openai.error!, /HTTP 503/);
		appStatus = 200;
		firstClient = "oaiapp_ambiguous";
		ambiguous = true;
		requests.length = 0;
		assert.match((await readCodexUsage([["openai", { clientId: firstClient }]])).openai.error!, /여러 계정/);
		assert.ok(requests.every((url) => url.endsWith("/apps")));
		assert.equal(await fs.access(marker).then(() => true, () => false), false);
		for (const [file, text] of files) assert.equal(await fs.readFile(file, "utf8"), text);
		assert.equal(await fs.readFile(modelPath, "utf8"), modelAuth);
		const cacheText = await fs.readFile(path.join(agentDir, "openai-account-quota.json"), "utf8");
		assert.equal(/signature|must-not-refresh|model-token-must-not-be-used|Authorization/.test(cacheText), false);
	} finally {
		mock.restoreAll();
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		await fs.rm(home, { recursive: true, force: true });
	}
});
