import assert from "node:assert/strict";
import test from "node:test";
import { accountToKeep, isAccountProvider, modelForAccount } from "../extensions/openai-accounts/model.ts";

test("two official accounts plus the temporary Codex account 3 participate", () => {
	for (const provider of ["openai", "openai-account-2", "openai-account-3"])
		assert.equal(isAccountProvider(provider), true);
	for (const provider of ["openai-codex", "openai-codex-account-2", "commandcode"])
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
	// Codex account 3 uses another API; never copy models across the two families.
	assert.equal(modelForAccount("openai-account-3", available, undefined), undefined);
	const codex = { provider: "openai-account-3", id: "gpt-6.1-sol" };
	assert.equal(modelForAccount("openai", codex, undefined, available), available);
});

test("/model keeps account 2, explicit account switches are respected", () => {
	assert.equal(accountToKeep("openai-account-2", "openai"), "openai-account-2");
	assert.equal(accountToKeep("openai-account-3", "openai"), "openai-account-3");
	for (const [from, to] of [
		["openai", "openai-account-2"], ["openai-account-2", "commandcode"],
		["openai-account-2", "openai-codex"], ["openai-account-3", "openai-account-2"],
		[undefined, "openai"],
	]) assert.equal(accountToKeep(from, to!), undefined);
});
