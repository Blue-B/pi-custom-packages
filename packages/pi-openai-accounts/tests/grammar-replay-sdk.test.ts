import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import {
	createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";

test("native OpenAI requests replay grammar tools safely across both accounts", { timeout: 30000 }, async () => {
	const home = await fs.mkdtemp(path.join(os.tmpdir(), "openai-grammar-replay-"));
	const previousHome = process.env.HOME;
	process.env.HOME = home;
	const agentDir = path.join(home, ".pi", "agent");
	await fs.mkdir(agentDir, { recursive: true });
	const providers = ["openai", "openai-account-2"];
	await fs.writeFile(path.join(agentDir, "auth.json"), JSON.stringify(Object.fromEntries(
		providers.map((provider) => [provider, { type: "oauth", access: "fixture-token", expires: Date.now() + 3600000 }]),
	)));
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		const runtime = await ModelRuntime.create();
		mock.method(ModelRuntime, "create", async () => runtime);
		const settings = SettingsManager.inMemory({ compaction: { enabled: false } });
		const loader = new DefaultResourceLoader({
			cwd: home, agentDir, settingsManager: settings,
			additionalExtensionPaths: [process.env.OPENAI_ACCOUNTS_ENTRY ??
				path.resolve("packages/pi-openai-accounts/extensions/openai-accounts/index.ts")],
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			systemPrompt: "Respond OK.", appendSystemPrompt: [],
		});
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		({ session } = await createAgentSession({
			cwd: home, agentDir, modelRuntime: runtime, model: runtime.getModel("openai", "gpt-6.1-sol")!,
			settingsManager: settings, resourceLoader: loader, sessionManager: SessionManager.inMemory(home), noTools: "all",
		}));
		let calls = 0;
		mock.method(globalThis, "fetch", async (_input: unknown, options: any) => {
			const payload = JSON.parse(options.body);
			const custom = payload.input.filter((item: any) => item.type === "custom_tool_call");
			assert.equal(custom.length, 2);
			for (const item of custom)
				assert.ok(item.id === undefined || item.id.startsWith("ctc_"), `Invalid custom item ID: ${item.id}`);
			assert.equal(custom[0].input, "return 1;");
			assert.equal(custom[1].id, "ctc_hook_valid", "valid IDs from payload hooks must survive");
			assert.equal(payload.input.find((item: any) => item.type === "custom_tool_call_output").call_id, custom[0].call_id);
			assert.equal(payload.input.find((item: any) => item.type === "function_call").id, "fc_function");
			assert.deepEqual(payload.metadata, { fixture: "preserved" });
			calls++;
			const events = [
				{ type: "response.created", response: { id: "resp_fixture", status: "in_progress", output: [] } },
				{ type: "response.completed", response: { id: "resp_fixture", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } } },
			];
			return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
				{ headers: { "content-type": "text/event-stream" } });
		});
		const tool = {
			name: "codemode", description: "Run code", parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
			constrainedSampling: { type: "grammar", variants: { openai_regex: ".*" } },
		};
		for (const target of providers) for (const source of providers) for (const prefix of ["ctc", "fc"]) {
			const model = runtime.getModel(target, "gpt-6.1-sol")!;
			const context: any = { messages: [
				{ role: "system", content: "Respond OK.", toolsAdded: [tool], timestamp: 0 },
				{ role: "assistant", provider: source, api: model.api, model: model.id, stopReason: "toolUse", timestamp: 1,
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					content: [{ type: "toolCall", id: `call_history|${prefix}_history`, name: "codemode", arguments: { code: "return 1;" } }] },
				{ role: "toolResult", toolCallId: `call_history|${prefix}_history`, toolName: "codemode", content: [{ type: "text", text: "1" }], timestamp: 2, isError: false },
			] };
			const before = structuredClone(context);
			for (const full of [false, true]) {
				const options = { onPayload: async (payload: any) => ({ ...payload,
					metadata: { fixture: "preserved" }, input: [...payload.input,
						{ type: "custom_tool_call", id: "ctc_hook_valid", call_id: "call_hook", name: "codemode", input: "return 2;" },
						{ type: "function_call", id: "fc_function", call_id: "call_function", name: "read", arguments: "{}" },
					],
				}) };
				const result = full ? await runtime.complete(model, context, options) : await runtime.completeSimple(model, context, options);
				assert.equal(result.stopReason, "stop", `${source} -> ${target}, ${prefix}, full=${full}: ${result.errorMessage}`);
				assert.deepEqual(context, before, "stored transcript must not be rewritten");
			}
		}
		assert.equal(calls, 16);
	} finally {
		session?.dispose();
		mock.restoreAll();
		if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
		await fs.rm(home, { recursive: true, force: true });
	}
});
