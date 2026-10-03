import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import { readBrowserUsage, readCachedUsage, remaining, usageForClient, windowLine } from "../extensions/openai-accounts/usage.ts";

test("browser usage matches issued app IDs and keeps plan/app windows distinct", async () => {
	const plan = { used_percent: 74, limit_window_seconds: 604800, reset_at: 1791129022 };
	const app = { used_percent: 1, limit_window_seconds: 604800, reset_at: 1791446772 };
	const body = { email: "one@example.com", rate_limit: { primary_window: plan, secondary_window: null } };
	const apps = { items: [{ id: "oaiapp_one", windows: [app] }] };
	const usage = usageForClient(body, apps, "oaiapp_one")!;
	assert.equal(usage.email, "one@example.com");
	assert.deepEqual(usage.plan, [plan]);
	assert.deepEqual(usage.app, [app]);
	assert.equal(usageForClient(body, apps, "oaiapp_other"), undefined);
	assert.equal(remaining(plan), 26);
	assert.equal(remaining(app), 99);
	assert.equal(remaining({ used_percent: -10 }), 100);
	assert.equal(remaining({ used_percent: 200 }), 0);
	assert.equal(remaining({ used_percent: NaN }), undefined);
	assert.equal(remaining({}), undefined);
	assert.match(windowLine("플랜", plan), /플랜 주간 ███░░░░░░░ 26% 남음.*초기화/);
	assert.match(windowLine("Pi 앱", app), /Pi 앱 주간 ██████████ 99% 남음/);
	assert.match(windowLine("플랜", { used_percent: 50, limit_window_seconds: 18000 }), /5시간/);
	assert.match(windowLine("플랜", {}), /수치 없음/);
	// Missing/fake native grants never start a browser or expose credentials.
	assert.deepEqual(await readBrowserUsage([["openai", { clientId: "issued-client" }]]), {});
});

test("parallel browser lookup caches numbers and failure status without losing previous values", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openai-browser-usage-"));
	const previous = { PATH: process.env.PATH, HOME: process.env.HOME, OPENAI_ACCOUNTS_USAGE_PROFILES: process.env.OPENAI_ACCOUNTS_USAGE_PROFILES };
	await fs.mkdir(path.join(dir, ".pi", "agent"), { recursive: true });
	await fs.writeFile(path.join(dir, "ab"), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(3);
const marker = process.env.HOME + '/second-profile-started';
if (args[1] === 'requests' && process.env.OPENAI_ACCOUNTS_USAGE_PROFILES.includes('slow')) {
 if (process.env.AB_PROFILE === 'fixture') fs.writeFileSync(marker, 'started');
 else {
  const start = Date.now();
  while (!fs.existsSync(marker)) {
   if (Date.now() - start > 2000) process.exit(1);
   Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
 }
}
if (args[0] === 'open') process.exit(1); // A warm browser must not reload.
let data = {};
if (args[1] === 'requests') data.requests = [
 {url: 'https://chatgpt.com/backend-api/wham/usage', status: 200, requestId: 'plan'},
 {url: 'https://chatgpt.com/backend-api/wham/usage/chatpass/apps', status: null, requestId: 'app'}
];
if (args[1] === 'request') data.headers = {'Authorization': 'Bearer fixture-web-token', 'ChatGPT-Account-Id': 'one', 'Cookie': 'private-cookie'};
console.log(JSON.stringify({success: true, data}));
`, { mode: 0o700 });
	try {
		process.env.PATH = `${dir}${path.delimiter}${previous.PATH}`;
		process.env.HOME = dir;
		process.env.OPENAI_ACCOUNTS_USAGE_PROFILES = "fixture";
		let status = 200;
		let modelRequests = 0;
		let usageRequests = 0;
		mock.method(globalThis, "fetch", async (url: string, options: any) => {
			usageRequests++;
			assert.ok(url.startsWith("https://chatgpt.com/backend-api/wham/usage"));
			assert.equal(options.headers.authorization, "Bearer fixture-web-token");
			assert.equal(options.headers.cookie, undefined);
			if (url.endsWith("responses")) modelRequests++;
			return new Response(JSON.stringify(url.endsWith("/apps")
				? { items: [{ id: "oaiapp_one", windows: [{ used_percent: 1, limit_window_seconds: 604800 }] }] }
				: { rate_limit: { primary_window: { used_percent: 74, limit_window_seconds: 604800 } } }), { status });
		});
		const entries: [string, { clientId: string }][] = [["openai", { clientId: "oaiapp_one" }], ["openai-account-2", { clientId: "oaiapp_two" }]];
		const usage = await readBrowserUsage(entries);
		assert.equal(remaining(usage.openai.plan[0]), 26);
		assert.equal(remaining(usage.openai.app[0]), 99);
		assert.match(usage["openai-account-2"].error!, /일치하지 않습니다/);
		const cacheText = await fs.readFile(path.join(dir, ".pi", "agent", "openai-account-quota.json"), "utf8");
		assert.equal(/fixture-web-token|private-cookie|Authorization/i.test(cacheText), false);
		assert.equal((await fs.stat(path.join(dir, ".pi", "agent", "openai-account-quota.json"))).mode & 0o777, 0o600);
		const saved = await readCachedUsage(entries);
		assert.match(saved["openai-account-2"].error!, /일치하지 않습니다/);
		assert.ok(saved["openai-account-2"].checkedAt);
		process.env.OPENAI_ACCOUNTS_USAGE_PROFILES = "slow,fixture";
		usageRequests = 0;
		await readBrowserUsage(entries);
		assert.equal(usageRequests, 4, "both profiles must start before the first profile completes");
		process.env.OPENAI_ACCOUNTS_USAGE_PROFILES = "fixture";
		const lastSuccess = (await readCachedUsage(entries)).openai.checkedAt;
		status = 503;
		assert.match((await readBrowserUsage(entries)).openai.error!, /HTTP 503/);
		const failed = await readCachedUsage(entries);
		assert.equal(remaining(failed.openai.plan[0]), 26);
		assert.equal(failed.openai.checkedAt, lastSuccess, "failure must not advance the last successful quota timestamp");
		assert.match(failed.openai.error!, /HTTP 503/);
		assert.match(failed["openai-account-2"].error!, /HTTP 503/);
		status = 200;
		await readBrowserUsage(entries);
		assert.equal((await readCachedUsage(entries)).openai.error, undefined, "successful refresh clears the saved failure");
		assert.equal((await readCachedUsage([["openai", { clientId: "oaiapp_new" }]])).openai, undefined);
		assert.equal(modelRequests, 0);
	} finally {
		mock.restoreAll();
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		await fs.rm(dir, { recursive: true, force: true });
	}
});
