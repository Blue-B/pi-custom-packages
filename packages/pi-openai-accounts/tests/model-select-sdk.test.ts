import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import {
	createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";

test("/model preserves the official account and commands explicitly switch it", { timeout: 30000 }, async () => {
	const home = await fs.mkdtemp(path.join(os.tmpdir(), "openai-model-select-"));
	const previous = { HOME: process.env.HOME, PATH: process.env.PATH, CODEX_HOME: process.env.CODEX_HOME,
		OPENAI_ACCOUNTS_CODEX_HOMES: process.env.OPENAI_ACCOUNTS_CODEX_HOMES };
	process.env.HOME = home;
	process.env.PATH = `${home}${path.delimiter}${previous.PATH}`;
	delete process.env.CODEX_HOME;
	delete process.env.OPENAI_ACCOUNTS_CODEX_HOMES;
	const browserMarker = path.join(home, "browser-called");
	await fs.writeFile(path.join(home, "ab"), `#!/bin/sh\ntouch "${browserMarker}"\nexit 1\n`, { mode: 0o700 });
	const agentDir = path.join(home, ".pi", "agent");
	await fs.mkdir(agentDir, { recursive: true });
	await fs.writeFile(path.join(agentDir, "auth.json"), JSON.stringify({
		openai: { type: "oauth", access: "fixture-only", clientId: "fixture-one" },
		"openai-account-2": { type: "oauth", access: "fixture-only", clientId: "fixture-two" },
	}));
	await fs.writeFile(path.join(agentDir, "openai-account-quota.json"), JSON.stringify({
		"fixture-two": { checkedAt: 1000, source: "web", plan: [{ used_percent: 5, limit_window_seconds: 18000 }], app: [] },
	}));
	mock.method(globalThis, "fetch", async () => assert.fail("Account commands must not query legacy quota servers"));
	try {
		const runtime = await ModelRuntime.create();
		mock.method(ModelRuntime, "create", async () => runtime);
		mock.method(runtime, "checkAuth", async () => true);
		const settings = SettingsManager.inMemory({ compaction: { enabled: false } });
		const loader = new DefaultResourceLoader({
			cwd: home, agentDir, settingsManager: settings,
			additionalExtensionPaths: [process.env.OPENAI_ACCOUNTS_ENTRY ?? process.env.CODEX_ACCOUNTS_ENTRY ??
				path.resolve("packages/pi-openai-accounts/extensions/openai-accounts/index.ts")],
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
			noContextFiles: true, systemPrompt: "Respond OK.", appendSystemPrompt: [],
		});
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		const { session } = await createAgentSession({
			cwd: home, agentDir, modelRuntime: runtime, model: runtime.getModels("openai")[0],
			settingsManager: settings, resourceLoader: loader,
			sessionManager: SessionManager.inMemory(home), noTools: "all",
		});
		try {
			await session.setModel(runtime.getModel("openai-account-2", "gpt-6.1-sol")!);
			await session.setModel(runtime.getModel("openai", "gpt-6-astra")!);
			assert.equal(session.model?.provider, "openai-account-2");
			assert.equal(session.model?.id, "gpt-6-astra");
			await session.setModel({ ...runtime.getModel("openai", "gpt-6-astra")!,
				provider: "commandcode", id: "deepseek/deepseek-v4.1-flash" });
			const commands = loader.getExtensions().extensions[0].commands;
			const command = commands.get("openai-accounts")!;
			assert.ok(command);
			assert.equal(commands.has("codex-accounts"), false);
			const notices: string[] = [];
			const widgets: string[][] = [];
			const context = (index: number) => {
				let finished!: () => void;
				const lookedUp = new Promise<void>((resolve) => { finished = resolve; });
				return {
					get model() { return session.model; },
					modelRegistry: (session as any)._extensionRunner.getModelRegistry(),
					ui: {
						setWidget(_id: string, lines?: string[]) {
							if (!lines) return;
							widgets.push(lines);
							if (lines.some((line) => line.includes("현재 한도 확인 불가")) &&
								!lines.some((line) => line.includes("(갱신 중)"))) finished();
						},
						select: async (_title: string, choices: string[]) => { await lookedUp; return choices[index]; },
						notify: (message: string) => notices.push(message),
					},
				};
			};
			await command.handler("", context(1) as any);
			assert.equal(session.model?.provider, "openai-account-2");
			assert.equal(session.model?.id, "gpt-6.1-sol");
			assert.ok(notices.at(-1)?.includes("모델: gpt-6.1-sol"));
			await command.handler("", context(0) as any);
			assert.equal(session.model?.provider, "openai");
			assert.equal(session.model?.id, "gpt-6.1-sol");
			assert.ok(widgets[0].some((line) => line.includes("현재 한도 갱신 중")));
			assert.ok(widgets.at(-1)!.some((line) => line.includes("현재 한도 확인 불가")));
			const savedNumbers = widgets.flatMap((lines) => lines.filter((line) => line.includes("95% 남음")));
			assert.ok(savedNumbers.length);
			assert.ok(savedNumbers.every((line) => line.includes("이전 조회 플랜")),
				"failed or pending refresh must not present cached quota as current");

			// Run the real ordinary menu handler with new grants and no quota cache.
			await fs.writeFile(path.join(agentDir, "auth.json"), JSON.stringify({
				openai: { type: "oauth", access: "fixture-only", clientId: "oaiapp_one" },
				"openai-account-2": { type: "oauth", access: "fixture-only", clientId: "oaiapp_two" },
			}));
			await fs.unlink(path.join(agentDir, "openai-account-quota.json"));
			for (const [folder, account] of [[".codex", "one"], [".codex-account-2", "two"]]) {
				await fs.mkdir(path.join(home, folder));
				await fs.writeFile(path.join(home, folder, "auth.json"), JSON.stringify({ tokens: {
					account_id: account, access_token: `header.${Buffer.from(JSON.stringify({
						"https://api.openai.com/auth": { chatgpt_account_id: account },
					})).toString("base64url")}.signature`,
				} }));
			}
			let calls = 0;
			mock.method(globalThis, "fetch", async (url: string, options: any) => {
				calls++;
				assert.ok(url.startsWith("https://chatgpt.com/backend-api/wham/usage"));
				const account = options.headers["ChatGPT-Account-Id"];
				return new Response(JSON.stringify(url.endsWith("/apps")
					? { items: [{ id: `oaiapp_${account}` }] }
					: { rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 18000 } } }));
			});
			let finished!: () => void;
			const lookedUp = new Promise<void>((resolve) => { finished = resolve; });
			const freshWidgets: string[][] = [];
			await command.handler("", {
				...context(0),
				ui: {
					setWidget(_id: string, lines?: string[]) {
						if (!lines) return;
						freshWidgets.push(lines);
						if (lines.filter((line) => line.includes("(Codex 조회)")).length === 2) finished();
					},
					select: async (_title: string, choices: string[]) => { await lookedUp; return choices.at(-1); },
					notify: (message: string) => notices.push(message),
				},
			} as any);
			assert.equal(calls, 4);
			assert.ok(freshWidgets[0].some((line) => line.includes("현재 한도 갱신 중")));
			assert.equal(freshWidgets.at(-1)!.filter((line) => line.includes("80% 남음")).length, 2);
			assert.ok(freshWidgets.at(-1)!.every((line) => !line.includes("이전 조회 플랜") && !line.includes("확인 불가")));
			const cache = JSON.parse(await fs.readFile(path.join(agentDir, "openai-account-quota.json"), "utf8"));
			assert.equal(cache.oaiapp_one.accountId, "one");
			assert.equal(cache.oaiapp_two.accountId, "two");
			assert.equal(await fs.access(browserMarker).then(() => true, () => false), false);
		} finally { session.dispose(); }
	} finally {
		mock.restoreAll();
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		await fs.rm(home, { recursive: true, force: true });
	}
});
