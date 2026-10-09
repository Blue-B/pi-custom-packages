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

// Real Pi lifecycle and installed extension; auth and model responses are fake.
test("single-account errors leave retries to the actual Pi lifecycle", {
	timeout: 30000,
}, async (t) => {
	const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-retry-sdk-"));
	const previousHome = process.env.HOME;
	process.env.HOME = home;
	const agentDir = path.join(home, ".pi", "agent");
	await fs.mkdir(agentDir, { recursive: true });
	const providers = [
		"openai",
		"openai-account-2",
	];
	await fs.writeFile(
		path.join(agentDir, "auth.json"),
		JSON.stringify(
			Object.fromEntries(
				providers.map((p) => [p, { type: "oauth", access: "fixture-only" }]),
			),
		),
	);
	const extension =
		process.env.OPENAI_ACCOUNTS_ENTRY ?? process.env.CODEX_ACCOUNTS_ENTRY ??
		path.resolve("packages/pi-openai-accounts/extensions/openai-accounts/index.ts");
	let abortOnRead: (() => void) | undefined;
	const readFile = fs.readFile.bind(fs);
	mock.method(fs, "readFile", async (...args: any[]) => {
		const result = await (readFile as any)(...args);
		if (String(args[0]) === path.join(agentDir, "auth.json")) {
			const callback = abortOnRead;
			abortOnRead = undefined;
			callback?.();
		}
		return result;
	});
	mock.method(globalThis, "fetch", async () => {
		assert.fail("No quota, model or authentication network access allowed");
	});
	try {
		// One runtime per case prevents test provider registrations from leaking to another case.
		const originalCreate = ModelRuntime.create.bind(ModelRuntime);
		const originalNow = Date.now;
		let clockOffset = 0;
		mock.method(Date, "now", () => originalNow() + clockOffset);
		for (const scenario of [
			"usage-limit",
			"native-retry",
			"abort",
			"abort-backoff",
			"all-exhausted",
		]) {
			await t.test(scenario, async () => {
				// Loaded modules retain cooldowns; expire previous cases without real waiting.
				clockOffset += 2 * 60 * 60 * 1000;
				const runtime = await originalCreate();
				const originalModel = runtime.getModels("openai")[0];
				assert.ok(originalModel);
				mock.method(ModelRuntime, "create", async () => runtime);
				mock.method(runtime, "checkAuth", async () => true);
				const calls: string[] = [],
					contexts: any[] = [];
				mock.method(runtime, "streamSimple", (model: any, context: any) => {
					calls.push(model.provider);
					contexts.push(structuredClone(context.messages));
					assert.ok(calls.length <= 4, "unbounded continuation loop");
					const fail = calls.length === 1 || scenario === "all-exhausted";
					const message: any = {
						role: "assistant",
						api: model.api,
						provider: model.provider,
						model: model.id,
						content: fail ? [] : [{ type: "text", text: "OK" }],
						timestamp: Date.now(),
						stopReason: fail ? "error" : "stop",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						...(fail
							? {
									errorMessage:
										scenario === "native-retry" || scenario === "abort-backoff"
											? "429 Too Many Requests"
											: "You have hit your ChatGPT usage limit",
								}
							: {}),
					};
					return {
						async *[Symbol.asyncIterator]() {
							yield { type: "start", partial: message };
							yield fail
								? { type: "error", reason: "error", error: message }
								: { type: "done", reason: "stop", message };
						},
						async result() {
							return message;
						},
					};
				});
				const settings = SettingsManager.inMemory({
					compaction: { enabled: false },
					retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
				});
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
				assert.equal(loader.getExtensions().extensions.length, 1);
				const { session } = await createAgentSession({
					cwd: home,
					agentDir,
					modelRuntime: runtime,
					model: originalModel,
					settingsManager: settings,
					resourceLoader: loader,
					sessionManager: SessionManager.inMemory(home),
					noTools: "all",
				});
				let aborted: Promise<void> | undefined;
				if (scenario === "abort")
					abortOnRead = () => {
						aborted = session.abort();
					};
				if (scenario === "abort-backoff")
					session.subscribe((event) => {
						if (event.type === "auto_retry_start")
							queueMicrotask(() => {
								aborted = session.abort();
							});
					});
				try {
					assert.equal(runtime.getProvider(providers[1]), undefined);
					await session.prompt("안녕");
					await session.waitForIdle();
					await aborted;
					const notices = session.messages.filter(
						(m: any) => m.role === "custom" && m.customType === "codex-account-retry",
					);
					console.log(
						JSON.stringify({
							scenario,
							calls,
							notices: notices.length,
							modelApiCalls: 0,
						}),
					);
					const expectedCalls = scenario === "native-retry" ? 2 : 1;
					const expectedNotices = 0;
					assert.equal(calls.length, expectedCalls);
					assert.equal(notices.length, expectedNotices);
					assert.equal(
						session.messages.filter((m) => m.role === "user").length,
						1,
						"no duplicated user request",
					);
					if (expectedCalls > 1) {
						assert.equal(calls[1], "openai");
					}
					if (!scenario.startsWith("abort")) {
						assert.equal(session.model?.provider, calls.at(-1));
					}
					for (const context of contexts)
						assert.equal(
							context.filter(
								(m: any) =>
									m.role === "user" &&
									(typeof m.content === "string"
										? m.content
										: JSON.stringify(m.content)
									).includes("안녕"),
							).length,
							1,
						);
				} finally {
					session.dispose();
				}
			});
		}
	} finally {
		mock.restoreAll();
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		await fs.rm(home, { recursive: true, force: true });
	}
});
