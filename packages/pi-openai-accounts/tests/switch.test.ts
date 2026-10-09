import assert from "node:assert/strict";
import test from "node:test";
import { isAccountProvider, modelForAccount } from "../extensions/openai-accounts/model.ts";

test("only the remaining official OpenAI account participates", () => {
	assert.equal(isAccountProvider("openai"), true);
	for (const provider of ["openai-account-2", "openai-account-3", "openai-codex-account-3", "openai-codex", "openai-codex-account-2", "commandcode"])
		assert.equal(isAccountProvider(provider), false);
});

test("keeps a custom model for the remaining OpenAI account", () => {
	const current = { provider: "openai", id: "gpt-6-astra", api: "openai-responses" };
	assert.deepEqual(modelForAccount("openai", current, undefined), current);
	assert.equal(modelForAccount("openai-account-2", current, undefined), undefined);
});

test("prefers the registered model of the target account", () => {
	const current = { provider: "openai", id: "gpt-6-astra" };
	const registered = { provider: "openai", id: current.id };
	assert.equal(modelForAccount(registered.provider, current, registered), registered);
});

test("uses the default model when moving from a foreign or legacy provider", () => {
	const available = { provider: "openai", id: "gpt-6.1-sol" };
	for (const provider of ["commandcode", "openai-codex"]) {
		const foreign = { provider, id: "legacy-only" };
		assert.equal(modelForAccount(available.provider, foreign, undefined, available), available);
		assert.equal(modelForAccount(available.provider, foreign, undefined), undefined);
	}
	assert.equal(modelForAccount(available.provider, undefined, undefined, available), available);
	assert.equal(modelForAccount("openai-codex", available, undefined), undefined);
	// Removed account 3 is a foreign provider, even if stale credentials remain.
	assert.equal(modelForAccount("openai-account-3", available, undefined), undefined);
	const codex = { provider: "openai-account-3", id: "gpt-6.1-sol" };
	assert.equal(modelForAccount("openai", codex, undefined, available), available);
});
