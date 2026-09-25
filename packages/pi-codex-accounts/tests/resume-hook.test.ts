import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import {
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

test("only the settled current failure resumes, without replaying a user request", async (t) => {
	const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-current-retry-"));
	const previousHome = process.env.HOME;
	process.env.HOME = home;
	const agentDir = path.join(home, ".pi", "agent");
	await fs.mkdir(agentDir, { recursive: true });
	const providers = [
		"openai-codex",
		"openai-codex-account-2",
		"openai-codex-account-3",
	];
	await fs.writeFile(
		path.join(agentDir, "auth.json"),
		JSON.stringify(
			Object.fromEntries(
				providers.map((p) => [p, { type: "oauth", access: "fixture-only" }]),
			),
		),
	);
	mock.method(ModelRuntime, "create", async () => ({
		getProvider: () => ({ auth: { oauth: { name: "fixture" } } }),
		getModels: () => [],
	}));
	let duringFetch: (() => void) | undefined;
	let available = true;
	mock.method(globalThis, "fetch", async () => {
		const callback = duringFetch;
		duringFetch = undefined;
		callback?.();
		return new Response(
			JSON.stringify({
				rate_limit: {
					allowed: available,
					primary_window: { used_percent: available ? 10 : 100 },
				},
			}),
		);
	});
	try {
		async function fixture() {
			const loader = new DefaultResourceLoader({
				cwd: home,
				agentDir,
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				additionalExtensionPaths: [
					path.resolve(
						"packages/pi-codex-accounts/extensions/codex-accounts/index.ts",
					),
				],
			});
			await loader.reload();
			const loaded = loader.getExtensions();
			assert.deepEqual(loaded.errors, []);
			const handlers = loaded.extensions[0].handlers;
			const sent: any[] = [];
			const aborter = new AbortController();
			let pending = false,
				idle = false,
				switchSucceeds = true,
				switches = 0;
			const model = (provider: string) => ({
				provider,
				id: "scope-fixture",
				api: "openai-codex-responses",
			});
			const ctx = {
				model: model(providers[0]),
				signal: aborter.signal,
				sessionManager: SessionManager.inMemory(home),
				modelRegistry: {
					find: (provider: string) => model(provider),
					getAvailable: () => providers.map(model),
				},
				hasPendingMessages: () => pending,
				isIdle: () => idle,
				ui: { notify() {} },
			} as unknown as ExtensionContext;
			Object.assign(loaded.runtime, {
				async setModel(next: ExtensionContext["model"]) {
					if (!switchSucceeds) return false;
					switches++;
					ctx.model = next;
					return true;
				},
				sendUserMessage() {
					assert.fail("must not manufacture a user request");
				},
				sendMessage(message: any, options: unknown) {
					assert.deepEqual(options, { triggerTurn: true });
					sent.push(message);
				},
			});
			const emit = async (name: string, event = {}) => {
				for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
			};
			const append = (text: string) =>
				(ctx.sessionManager as SessionManager).appendMessage({
					role: "user",
					content: text,
					timestamp: Date.now(),
				});
			append("Earlier task must not be replayed");
			append("안녕");
			const fail = async (provider = ctx.model!.provider) => {
				const sm = ctx.sessionManager as SessionManager;
				const message: any = {
					role: "assistant",
					provider,
					model: "scope-fixture",
					content: [],
					timestamp: Date.now(),
					usage: { totalTokens: 0 },
					stopReason: "error",
					errorMessage: "You have hit your ChatGPT usage limit",
				};
				await emit("message_start", { message });
				await emit("message_end", { message });
				assert.equal(sent.length, 0, "message_end must leave native retry alone");
				return sm.appendMessage(message); // Pi persists after extension message_end handlers.
			};
			return {
				ctx,
				emit,
				append,
				appendRetryNotice: () =>
					(ctx.sessionManager as SessionManager).appendCustomMessageEntry(
						"codex-account-retry", "previous continuation", true,
					),
				fail,
				sent,
				aborter,
				setPending: () => {
					pending = true;
				},
				rejectSwitch: () => {
					switchSucceeds = false;
				},
				switches: () => switches,
				settle: async () => {
					idle = true;
					await emit("agent_settled");
				},
			};
		}
		await t.test(
			"one continuation, exact failed entry, no copied old request",
			async () => {
				const f = await fixture();
				const id = await f.fail();
				await f.settle();
				await f.settle();
				assert.equal(f.switches(), 1);
				assert.equal(f.sent.length, 1);
				assert.equal(f.sent[0].customType, "codex-account-retry");
				assert.deepEqual(f.sent[0].details, { failedMessageId: id });
				assert.doesNotMatch(f.sent[0].content, /Earlier task|안녕/);
				assert.equal(
					f.ctx.sessionManager
						.getBranch()
						.filter((e) => e.type === "message" && e.message.role === "user").length,
					2,
				);
			},
		);
		await t.test("a session reload cannot restart an exhausted retry chain", async () => {
			const f = await fixture();
			f.appendRetryNotice();
			f.appendRetryNotice();
			await f.fail();
			await f.settle();
			assert.equal(f.sent.length, 0);
			assert.equal(f.switches(), 0, "an exhausted chain must not rotate again");
			f.append("new user request");
			await f.fail();
			await f.settle();
			assert.equal(f.sent.length, 1, "a new request gets its own retry budget");
		});
		for (const action of [
			"input",
			"message_start",
			"session_before_switch",
			"session_before_tree",
			"session_shutdown",
		]) {
			await t.test(`${action} cancels a pending continuation`, async () => {
				const f = await fixture();
				await f.fail();
				await f.emit(action);
				await f.settle();
				assert.equal(f.sent.length, 0);
			});
		}
		for (const action of [
			"abort",
			"pending",
			"session",
			"model",
			"branch",
			"busy",
		]) {
			await t.test(
				`${action} before settlement prevents continuation`,
				async () => {
					const f = await fixture();
					await f.fail();
					if (action === "abort") f.aborter.abort();
					if (action === "pending") f.setPending();
					if (action === "session")
						f.ctx.sessionManager = SessionManager.inMemory(home);
					if (action === "model") f.ctx.model = { ...f.ctx.model! };
					if (action === "branch") f.append("new request");
					if (action === "busy") {
						await f.emit("agent_settled");
					} else await f.settle();
					assert.equal(f.sent.length, 0);
				},
			);
		}
		for (const action of [
			"abort",
			"input",
			"session",
			"model",
			"branch",
			"pending",
		]) {
			await t.test(
				`${action} during quota lookup prevents stale failover`,
				async () => {
					const f = await fixture();
					duringFetch = () => {
						if (action === "abort") f.aborter.abort();
						if (action === "input") f.emit("input");
						if (action === "session")
							f.ctx.sessionManager = SessionManager.inMemory(home);
						if (action === "model") f.ctx.model = { ...f.ctx.model! };
						if (action === "branch") f.append("cancel the previous task");
						if (action === "pending") f.setPending();
					};
					await f.fail();
					await f.settle();
					assert.equal(f.switches(), 0);
					assert.equal(f.sent.length, 0);
				},
			);
		}
		await t.test(
			"no continuation without successful account switching",
			async () => {
				const f = await fixture();
				f.rejectSwitch();
				await f.fail();
				await f.settle();
				assert.equal(f.sent.length, 0);
				available = false;
				const g = await fixture();
				await g.fail();
				await g.settle();
				assert.equal(g.switches(), 0);
				assert.equal(g.sent.length, 0);
				available = true;
			},
		);
		await t.test(
			"a foreign provider error never rotates the current account",
			async () => {
				const f = await fixture();
				await f.fail(providers[1]);
				await f.settle();
				assert.equal(f.switches(), 0);
				assert.equal(f.sent.length, 0);
			},
		);
		await assert.rejects(
			fs.access(path.join(agentDir, "codex-account-auto-resume.json")),
		);
	} finally {
		mock.restoreAll();
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		await fs.rm(home, { recursive: true, force: true });
	}
});
