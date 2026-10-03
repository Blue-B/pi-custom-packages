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
	const previousHome = process.env.HOME;
	process.env.HOME = home;
	const agentDir = path.join(home, ".pi", "agent");
	await fs.mkdir(agentDir, { recursive: true });
	await fs.writeFile(path.join(agentDir, "auth.json"), JSON.stringify({
		openai: { type: "oauth", access: "fixture-only" },
		"openai-account-2": { type: "oauth", access: "fixture-only" },
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
			const context = (index: number) => ({
				get model() { return session.model; },
				modelRegistry: (session as any)._extensionRunner.getModelRegistry(),
				ui: { setWidget() {}, select: async (_title: string, choices: string[]) => choices[index],
					notify: (message: string) => notices.push(message) },
			});
			await command.handler("", context(1) as any);
			assert.equal(session.model?.provider, "openai-account-2");
			assert.equal(session.model?.id, "gpt-6.1-sol");
			assert.ok(notices.at(-1)?.includes("모델: gpt-6.1-sol"));
			await command.handler("", context(0) as any);
			assert.equal(session.model?.provider, "openai");
			assert.equal(session.model?.id, "gpt-6.1-sol");
		} finally { session.dispose(); }
	} finally {
		mock.restoreAll();
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		await fs.rm(home, { recursive: true, force: true });
	}
});
