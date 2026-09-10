import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import { ModelRuntime, SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { resumeMessage } from "../extensions/codex-accounts/auto-resume.ts";

test("quota hook keeps the current request and does not override new input", async () => {
	const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-resume-hook-"));
	const previousHome = process.env.HOME;
	process.env.HOME = home;
	const agentDir = path.join(home, ".pi", "agent");
	await fs.mkdir(agentDir, { recursive: true });
	const providers = Array.from({ length: 12 }, (_, i) => i === 0 ? "openai-codex" : `openai-codex-account-${i + 1}`);
	await fs.writeFile(path.join(agentDir, "auth.json"), JSON.stringify(Object.fromEntries(providers.map((provider) => [provider, { type: "oauth", access: "fixture-only" }]))));
	let duringFetch: (() => void) | undefined;
	mock.method(ModelRuntime, "create", async () => ({
		getProvider: () => ({ auth: { oauth: { name: "fixture" } } }),
		getModels: () => [],
	}));
	mock.method(globalThis, "fetch", async () => {
		const callback = duringFetch;
		duringFetch = undefined;
		callback?.();
		return new Response(JSON.stringify({ rate_limit: { allowed: true, primary_window: { used_percent: 10 } } }));
	});
	try {
		// Import after HOME is isolated: no real credentials, usage files or leases.
		const { default: install } = await import("../extensions/codex-accounts/index.ts");
		const handlers = new Map<string, (...args: unknown[]) => Promise<void>>();
		const sent: ReturnType<typeof resumeMessage>[] = [];
		let pending = false;
		const model = (provider: string) => ({ provider, id: "scope-fixture", api: "openai-codex-responses" });
		const ctx = {
			model: model(providers[0]),
			sessionManager: SessionManager.inMemory(home),
			modelRegistry: { find: (provider: string) => model(provider), getAvailable: () => providers.map(model) },
			hasPendingMessages: () => pending,
			ui: { notify() {} },
		} as unknown as ExtensionContext;
		const append = (text: string) => (ctx.sessionManager as SessionManager).appendMessage({ role: "user", content: text, timestamp: Date.now() });
		const pi = {
			registerProvider() {}, registerCommand() {},
			on(name: string, handler: (...args: unknown[]) => Promise<void>) { handlers.set(name, handler); },
			async setModel(next: ExtensionContext["model"]) { ctx.model = next; return true; },
			sendUserMessage() { assert.fail("automatic recovery must not manufacture a user request"); },
			sendMessage(message: ReturnType<typeof resumeMessage>, options: unknown) {
				assert.deepEqual(options, { deliverAs: "steer", triggerTurn: true });
				sent.push(message);
				(ctx.sessionManager as SessionManager).appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
			},
		} as unknown as ExtensionAPI;
		await install(pi);
		const quotaError = () => handlers.get("message_end")!({ message: {
			role: "assistant", provider: ctx.model!.provider, usage: { totalTokens: 0 },
			stopReason: "error", errorMessage: "usage limit",
		} }, ctx);
		const settle = () => handlers.get("agent_settled")!({ type: "agent_settled" }, ctx);
		const fail = async () => { await quotaError(); await settle(); };

		append("예전 Memnest 설치 수정");
		const greetingId = append("안녕");
		await fail();
		assert.equal(sent.length, 1);
		assert.equal(sent[0].details.requestId, greetingId);
		assert.match(sent[0].content, /원래 사용자 요청: "안녕"/);
		assert.doesNotMatch(sent[0].content, /Memnest/);
		await fail();
		assert.equal(sent.length, 2);
		assert.deepEqual(sent[1], sent[0]);
		assert.equal(ctx.sessionManager.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "user").length, 2);

		const codingId = append("현재 프로젝트 A만 고쳐. B는 수정하지 마.");
		await fail();
		assert.equal(sent.length, 3);
		assert.equal(sent[2].details.requestId, codingId);
		assert.match(sent[2].content, /B는 수정하지 마/);
		await settle();

		ctx.sessionManager = SessionManager.inMemory(home);
		await fail();
		assert.equal(sent.length, 3, "empty sessions must not recover a task from elsewhere");
		append("안녕");
		pending = true;
		await fail();
		assert.equal(sent.length, 3, "queued input wins over an automatic follow-up");
		pending = false;
		duringFetch = () => { append("이전 요청 취소. 날짜만 알려줘."); };
		await fail();
		assert.equal(sent.length, 3, "new input during account lookup must not be overridden");
		await assert.rejects(fs.access(path.join(agentDir, "codex-account-auto-resume.json")));

		const beforeSwitch = ctx.model;
		duringFetch = () => { ctx.sessionManager = SessionManager.inMemory(home); };
		await fail();
		assert.equal(ctx.model, beforeSwitch, "a different session must not inherit the old failover");
		assert.equal(sent.length, 3);
		await settle();
	} finally {
		mock.restoreAll();
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		await fs.rm(home, { recursive: true, force: true });
	}
});
