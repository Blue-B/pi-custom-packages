import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

// Real Pi lifecycle and installed extension. Reproduces: /model은 enabledModels
// 스코프(공유 별칭 openai-codex)만 보여주므로, 계정을 골라 둔 상태에서 /model로
// 모델을 바꾸면 provider가 공유 별칭으로 바뀌며 계정이 1번으로 되돌아갔다.
test("/model keeps the selected Codex account", { timeout: 30000 }, async () => {
	const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-model-select-"));
	const previousHome = process.env.HOME;
	process.env.HOME = home;
	const agentDir = path.join(home, ".pi", "agent");
	await fs.mkdir(agentDir, { recursive: true });
	await fs.writeFile(
		path.join(agentDir, "auth.json"),
		JSON.stringify(
			Object.fromEntries(
				["openai-codex", "openai-codex-account-2", "openai-codex-account-3"].map(
					(p) => [p, { type: "oauth", access: "fixture-only" }],
				),
			),
		),
	);
	const extension =
		process.env.CODEX_ACCOUNTS_ENTRY ??
		path.resolve("packages/pi-codex-accounts/extensions/codex-accounts/index.ts");
	mock.method(globalThis, "fetch", async (url: unknown) => {
		assert.equal(String(url), "https://chatgpt.com/backend-api/wham/usage");
		return new Response(JSON.stringify({ rate_limit: { allowed: true } }));
	});
	try {
		const runtime = await ModelRuntime.create();
		mock.method(ModelRuntime, "create", async () => runtime);
		mock.method(runtime, "checkAuth", async () => true);
		const settings = SettingsManager.inMemory({ compaction: { enabled: false } });
		const loader = new DefaultResourceLoader({
			cwd: home,
			agentDir,
			settingsManager: settings,
			additionalExtensionPaths: [extension],
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPrompt: "Respond OK.",
			appendSystemPrompt: [],
		});
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		const { session } = await createAgentSession({
			cwd: home,
			agentDir,
			modelRuntime: runtime,
			model: runtime.getModels("openai-codex")[0],
			settingsManager: settings,
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(home),
			noTools: "all",
		});
		try {
			// /codex-accounts로 3번 계정에 올라탄 상태
			await session.setModel(
				runtime.getModel("openai-codex-account-3", "gpt-5.6-sol")!,
			);
			assert.equal(session.model?.provider, "openai-codex-account-3");

			// /model에서 스코프에 보이는 공유 별칭 모델을 고른다
			await session.setModel(runtime.getModel("openai-codex", "gpt-6-astra")!);

			assert.equal(
				session.model?.provider,
				"openai-codex-account-3",
				"account must survive a /model change",
			);
			assert.equal(session.model?.id, "gpt-6-astra", "chosen model must be kept");

			// 계정을 직접 고르면 그 선택은 그대로 존중한다
			await session.setModel(
				runtime.getModel("openai-codex-account-2", "gpt-6-astra")!,
			);
			assert.equal(session.model?.provider, "openai-codex-account-2");

			// DeepSeek 같은 다른 제공자에서 /codex-accounts로 2번을 고른다.
			await session.setModel({
				...runtime.getModel("openai-codex", "gpt-6-astra")!,
				provider: "commandcode",
				id: "deepseek/deepseek-v4.1-flash",
			});
			const command = loader.getExtensions().extensions[0].commands.get("codex-accounts")!;
			const notices: string[] = [];
			await command.handler("", {
				get model() { return session.model; },
				modelRegistry: (session as any)._extensionRunner.getModelRegistry(),
				ui: {
					setWidget() {},
					select: async (_title: string, choices: string[]) => choices[1],
					notify: (message: string) => notices.push(message),
				},
			} as any);
			assert.equal(session.model?.provider, "openai-codex-account-2");
			assert.notEqual(session.model?.id, "deepseek/deepseek-v4.1-flash");
			assert.ok(runtime.getModel("openai-codex-account-2", session.model!.id));
			assert.ok(notices.at(-1)?.includes(`모델: ${session.model!.id}`));

			// 명시적인 1번 계정 선택은 /model의 계정 유지와 다르다.
			const selectedModel = session.model!.id;
			await command.handler("", {
				get model() { return session.model; },
				modelRegistry: (session as any)._extensionRunner.getModelRegistry(),
				ui: {
					setWidget() {},
					select: async (_title: string, choices: string[]) => choices[0],
					notify: (message: string) => notices.push(message),
				},
			} as any);
			assert.equal(session.model?.provider, "openai-codex");
			assert.equal(session.model?.id, selectedModel);
		} finally {
			session.dispose();
		}
	} finally {
		mock.restoreAll();
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		await fs.rm(home, { recursive: true, force: true });
	}
});
