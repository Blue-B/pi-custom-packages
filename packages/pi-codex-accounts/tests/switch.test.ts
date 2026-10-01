import assert from "node:assert/strict";
import test from "node:test";
import { accountToKeep, isAccountProvider, modelForAccount } from "../extensions/codex-accounts/model.ts";

test("only the two official subscription accounts participate", () => {
	assert.equal(isAccountProvider("openai"), true);
	assert.equal(isAccountProvider("openai-account-2"), true);
	for (const provider of ["openai-account-3", "openai-codex", "openai-codex-account-2", "commandcode"])
		assert.equal(isAccountProvider(provider), false);
});

test("keeps a custom OpenAI model during account rotation", () => {
	const current = { provider: "openai", id: "gpt-6-astra", api: "openai-responses" };
	assert.deepEqual(modelForAccount("openai-account-2", current, undefined),
		{ ...current, provider: "openai-account-2" });
});

test("prefers the registered model of the target account", () => {
	const current = { provider: "openai", id: "gpt-6-astra" };
	const registered = { provider: "openai-account-2", id: current.id };
	assert.equal(modelForAccount(registered.provider, current, registered), registered);
});

test("uses the default model when moving from a foreign or legacy provider", () => {
	const available = { provider: "openai-account-2", id: "gpt-6.1-sol" };
	for (const provider of ["commandcode", "openai-codex"]) {
		const foreign = { provider, id: "legacy-only" };
		assert.equal(modelForAccount(available.provider, foreign, undefined, available), available);
		assert.equal(modelForAccount(available.provider, foreign, undefined), undefined);
	}
	assert.equal(modelForAccount(available.provider, undefined, undefined, available), available);
	assert.equal(modelForAccount("openai-codex", available, undefined), undefined);
});

test("/model keeps account 2, explicit account switches are respected", () => {
	assert.equal(accountToKeep("openai-account-2", "openai"), "openai-account-2");
	for (const [from, to] of [
		["openai", "openai-account-2"], ["openai-account-2", "commandcode"],
		["openai-account-2", "openai-codex"], ["openai-account-3", "openai"],
		[undefined, "openai"],
	]) assert.equal(accountToKeep(from, to!), undefined);
});
