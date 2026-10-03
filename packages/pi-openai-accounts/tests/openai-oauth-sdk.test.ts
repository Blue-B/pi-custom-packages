import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import {
	createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";

test("two native ChatGPT accounts retain OAuth grants, routing and model metadata", { timeout: 30000 }, async () => {
	const home = await fs.mkdtemp(path.join(os.tmpdir(), "openai-accounts-"));
	const previousHome = process.env.HOME;
	process.env.HOME = home;
	const agentDir = path.join(home, ".pi", "agent");
	await fs.mkdir(agentDir, { recursive: true });
	const authPath = path.join(agentDir, "auth.json");
	const credential = { type: "oauth" as const, access: "test-direct-token", refresh: "test-refresh",
		expires: Date.now() + 3600000, clientId: "issued-client", scopes: ["chatgpt.tokens.use.direct"] };
	await fs.writeFile(authPath, JSON.stringify({
		openai: credential, "openai-account-2": credential,
		"openai-account-3": credential,
		"openai-codex-account-3": { type: "oauth", access: "legacy-must-not-be-used" },
	}));
	await fs.writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: {
		openai: { modelOverrides: { "gpt-6.1-sol": { contextWindow: 1050000, maxTokens: 128000 } } },
	} }));
	try {
		const runtime = await ModelRuntime.create();
		const official = runtime.getProvider("openai")!;
		let loginDeviceId: string | undefined;
		mock.method(official.auth.oauth!, "login", async (_interaction: unknown, options: any) => {
			loginDeviceId = options.getDeviceId();
			return credential;
		});
		let refreshed = false;
		mock.method(official.auth.oauth!, "refresh", async (stored: any) => {
			assert.equal(stored.clientId, "issued-client");
			assert.deepEqual(stored.scopes, ["chatgpt.tokens.use.direct"]);
			refreshed = true;
			return { ...credential, access: "test-refreshed-token" };
		});
		mock.method(ModelRuntime, "create", async () => runtime);
		const settings = SettingsManager.inMemory({ compaction: { enabled: false } });
		const loader = new DefaultResourceLoader({
			cwd: home, agentDir, settingsManager: settings,
			additionalExtensionPaths: [process.env.OPENAI_ACCOUNTS_ENTRY ?? process.env.CODEX_ACCOUNTS_ENTRY ??
				path.resolve("packages/pi-openai-accounts/extensions/openai-accounts/index.ts")],
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			systemPrompt: "Respond OK.", appendSystemPrompt: [],
		});
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		const { session } = await createAgentSession({
			cwd: home, agentDir, modelRuntime: runtime, model: runtime.getModel("openai", "gpt-6.1-sol")!,
			settingsManager: settings, resourceLoader: loader,
			sessionManager: SessionManager.inMemory(home), noTools: "all",
		});
		try {
			// Session binding applies provider registrations; no extra slots are created.
			assert.ok(runtime.getProvider("openai-account-2"));
			assert.equal(runtime.getProvider("openai-account-3"), undefined);
			assert.equal(runtime.getProvider("openai-codex-account-3"), undefined);
			const alias = runtime.getModel("openai-account-2", "gpt-6.1-sol")!;
			assert.ok(alias);
			assert.equal(alias.contextWindow, 1050000);
			assert.equal(alias.maxTokens, 128000);
			assert.equal(alias.api, "openai-responses");
			assert.equal(alias.baseUrl, "https://api.openai.com/v1");
			assert.deepEqual(alias.thinkingLevelMap, runtime.getModel("openai", alias.id)!.thinkingLevelMap);
			await runtime.login(alias.provider, "oauth", {
				signal: new AbortController().signal, notify() {}, prompt: async () => "unused",
			}, { getDeviceId: () => "00000000-0000-4000-8000-000000000002" });
			assert.equal(loginDeviceId, "00000000-0000-4000-8000-000000000002");
			const stored = JSON.parse(await fs.readFile(authPath, "utf8"));
			assert.equal(stored[alias.provider].clientId, credential.clientId);
			assert.deepEqual(stored[alias.provider].scopes, credential.scopes);
			stored[alias.provider].expires = 0;
			await fs.writeFile(authPath, JSON.stringify(stored));
			await runtime.getAuth(alias);
			assert.ok(refreshed, "native refresh must retain clientId and scopes");

			let apiCalls = 0;
			let payloadHooks = 0;
			mock.method(globalThis, "fetch", async (input: any, options: any) => {
				assert.equal(String(input?.url ?? input), "https://api.openai.com/v1/responses");
				assert.equal(new Headers(options?.headers ?? input.headers).get("authorization"), "Bearer test-refreshed-token");
				const payload = JSON.parse(options.body);
				for (const field of ["max_output_tokens", "temperature", "prompt_cache_retention", "prompt_cache_options"])
					assert.equal(field in payload, false, `subscription alias must omit ${field}`);
				if (apiCalls < 2) assert.deepEqual(payload.metadata, { fixture: "hook-preserved" });
				apiCalls++;
				const events = [
					{ type: "response.created", response: { id: "test-response", status: "in_progress", output: [] } },
					{ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "test-message", role: "assistant", content: [] } },
					{ type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
					{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "OK" },
					{ type: "response.completed", response: { id: "test-response", status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } } },
				];
				return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
					{ headers: { "content-type": "text/event-stream" } });
			});
			const context = { messages: [{ role: "user" as const, content: "Say OK.", timestamp: Date.now() }] };
			const options = {
				maxTokens: 16, temperature: 0.1, cacheRetention: "long" as const, sessionId: "fixture-session",
				onPayload: async (payload: unknown, model: any) => {
					assert.equal(model.provider, alias.provider);
					payloadHooks++;
					return { ...(payload as object), metadata: { fixture: "hook-preserved" } };
				},
			};
			const result = await runtime.completeSimple(alias, context, options);
			assert.equal(result.stopReason, "stop", result.errorMessage ?? "Unexpected stop reason");
			assert.equal(result.provider, "openai-account-2");
			assert.deepEqual(result.content, [{ type: "text", text: "OK" }]);
			assert.equal(apiCalls, 1);
			const full = await runtime.complete(alias, context, options);
			assert.equal(full.stopReason, "stop");
			assert.equal(full.provider, alias.provider);
			assert.equal(payloadHooks, 2, "both streaming paths must preserve instrumentation hooks");
			await session.setModel(alias);
			await session.prompt("Say OK.");
			await session.waitForIdle();
			const usage = JSON.parse(await fs.readFile(path.join(agentDir, "codex-account-usage.json"), "utf8"));
			assert.equal(usage[alias.provider].total, 11);
			assert.equal(usage[alias.provider].resetAt, undefined, "local totals do not invent subscription reset windows");
			assert.equal(apiCalls, 3);

			// Native direct OAuth tokens can identify a user without carrying an email.
			const menuAuth = JSON.parse(await fs.readFile(authPath, "utf8"));
			const menuToken = (payload: object) => `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
			menuAuth.openai.access = menuToken({ sub: "user-one", email: "one@example.com" });
			menuAuth[alias.provider].access = menuToken({ sub: "user-two", "https://api.openai.com/auth": {} });
			await fs.writeFile(authPath, JSON.stringify(menuAuth));
			const command = loader.getExtensions().extensions[0].commands.get("openai-accounts")!;
			const widgets: string[] = [];
			let selections = 0;
			await command.handler("", {
				get model() { return session.model; },
				modelRegistry: (session as any)._extensionRunner.getModelRegistry(),
				ui: { setWidget: (_key: string, lines?: string[]) => { if (lines) widgets.push(lines.join("\n")); },
					select: async (title: string, choices: string[]) => {
						assert.ok(title.includes("로그인 2/2개"));
						assert.equal(choices.length, 4, "only two accounts, refresh and close");
						assert.ok(choices[0].includes("1번  one@example.com"));
						assert.ok(choices[1].includes("2번  ChatGPT 로그인됨"));
						assert.ok(choices[1].includes("← 현재"));
						assert.equal(choices.some((choice) => choice.includes("이메일 없음")), false);
						return selections++ === 0 ? choices[2] : choices[1];
					}, notify() {} },
			} as any);
			assert.equal(session.model?.provider, "openai-account-2");
			assert.ok(widgets[0].includes("한도 조회 중"));
			assert.ok(widgets[0].includes("로그인 2/2개"));
			assert.equal(apiCalls, 3, "account menus must never send direct tokens to legacy endpoints");

			// Codex reads are non-blocking; menus never start a browser or show app limits.
			const previousPath = process.env.PATH;
			const previousCodexHome = process.env.CODEX_HOME;
			const previousCodexHomes = process.env.OPENAI_ACCOUNTS_CODEX_HOMES;
			const browserMarker = path.join(home, "browser-started");
			await fs.writeFile(path.join(home, "ab"), `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(browserMarker)}, 'started');\n`, { mode: 0o700 });
			menuAuth.openai.clientId = "oaiapp_slow";
			await fs.writeFile(authPath, JSON.stringify(menuAuth));
			const unchangedAuth = await fs.readFile(authPath, "utf8");
			const codexHome = path.join(home, ".codex");
			await fs.mkdir(codexHome);
			await fs.writeFile(path.join(codexHome, "auth.json"), JSON.stringify({ tokens: {
				access_token: menuToken({ "https://api.openai.com/auth": { chatgpt_account_id: "account-one" } }),
				account_id: "account-one",
			} }));
			await fs.writeFile(path.join(agentDir, "openai-account-quota.json"), JSON.stringify({
				oaiapp_slow: { accountId: "account-one", email: "one@example.com", source: "web", checkedAt: Date.now(),
					plan: [{ used_percent: 74, limit_window_seconds: 604800 }], app: [{ used_percent: 1, limit_window_seconds: 604800 }] },
			}));
			let quotaCalls = 0;
			mock.method(globalThis, "fetch", async (url: string) => {
				assert.equal(url, "https://chatgpt.com/backend-api/wham/usage");
				quotaCalls++;
				await new Promise((resolve) => setTimeout(resolve, 800));
				return new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 604800 } } }));
			});
			try {
				process.env.PATH = `${home}${path.delimiter}${previousPath}`;
				process.env.CODEX_HOME = codexHome;
				delete process.env.OPENAI_ACCOUNTS_CODEX_HOMES;
				const start = Date.now();
				let shownAt = 0;
				let closed = false;
				let lateWidgets = 0;
				await command.handler("", {
					get model() { return session.model; },
					ui: {
						setWidget: (_key: string, lines?: string[]) => { if (!lines) closed = true; else if (closed) lateWidgets++; },
						select: async () => { shownAt = Date.now(); return "닫기"; }, notify() {},
					},
				} as any);
				assert.ok(shownAt - start < 500, `picker blocked for ${shownAt - start}ms`);
				await new Promise((resolve) => setTimeout(resolve, 1100));
				assert.equal(lateWidgets, 0);
				assert.equal(quotaCalls, 1);
				const quotaWidgets: string[] = [];
				await command.handler("", {
					get model() { return session.model; },
					ui: {
						setWidget: (_key: string, lines?: string[]) => { if (lines) quotaWidgets.push(lines.join("\n")); },
						select: async () => { await new Promise((resolve) => setTimeout(resolve, 1100)); return "닫기"; }, notify() {},
					},
				} as any);
				assert.ok(quotaWidgets.some((lines) => /플랜 주간.*75% 남음/.test(lines) && lines.includes("Codex 조회")));
				assert.ok(quotaWidgets.every((lines) => !lines.includes("Pi 앱")));
				assert.ok(quotaWidgets.some((lines) => lines.includes("현재 한도 확인 불가") &&
					lines.includes("동일 계정의 Codex 조회 인증 없음")));
				assert.ok(quotaWidgets.every((lines) => !lines.includes("web으로 한 번 연결")));
				assert.equal(await fs.stat(browserMarker).catch(() => undefined), undefined);
				assert.equal(await fs.readFile(authPath, "utf8"), unchangedAuth);
				assert.equal(apiCalls, 3);
			} finally {
				if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
				if (previousCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousCodexHome;
				if (previousCodexHomes === undefined) delete process.env.OPENAI_ACCOUNTS_CODEX_HOMES;
				else process.env.OPENAI_ACCOUNTS_CODEX_HOMES = previousCodexHomes;
			}
		} finally { session.dispose(); }
	} finally {
		mock.restoreAll();
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		await fs.rm(home, { recursive: true, force: true });
	}
});
