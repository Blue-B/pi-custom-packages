import assert from "node:assert/strict";
import test from "node:test";
import { accountToKeep, modelForAccount } from "../extensions/codex-accounts/model.ts";

test("keeps a custom Codex model when switching accounts", () => {
	const current = {
		provider: "openai-codex",
		id: "gpt-6-astra",
		api: "openai-codex-responses",
	};

	assert.deepEqual(
		modelForAccount("openai-codex-account-2", current, undefined),
		{ ...current, provider: "openai-codex-account-2" },
	);
});

test("prefers the registered model of the target account", () => {
	const current = { provider: "openai-codex", id: "gpt-6-astra" };
	const registered = { provider: "openai-codex-account-2", id: "gpt-6-astra" };

	assert.deepEqual(
		modelForAccount("openai-codex-account-2", current, registered),
		registered,
	);
});

test("switches from another provider to an available Codex model", () => {
	const foreign = { provider: "commandcode", id: "deepseek/deepseek-v4.1-flash" };
	const available = { provider: "openai-codex-account-2", id: "gpt-6-sol" };

	assert.equal(modelForAccount("openai-codex-account-2", foreign, undefined, available), available);
	assert.equal(modelForAccount("openai-codex-account-2", undefined, undefined, available), available);
	assert.equal(modelForAccount("openai-codex-account-2", foreign, undefined), undefined);
	assert.equal(modelForAccount("openai-codex-account-2", undefined, undefined), undefined);
});

test("does not silently change a Codex model during account rotation", () => {
	const current = { provider: "openai-codex", id: "gpt-6-astra" };
	const available = { provider: "openai-codex-account-2", id: "gpt-5.6-sol" };
	assert.deepEqual(modelForAccount(available.provider, current, undefined, available), {
		...current,
		provider: available.provider,
	});
});

test("keeps the account when /model picks a shared-alias model", () => {
	// /model은 enabledModels 스코프(공유 별칭)만 보여주므로, 계정 사용 중
	// 모델만 바꾸면 계정이 1번으로 되돌아갔다. 그 경우에만 계정을 유지한다.
	assert.equal(accountToKeep("openai-codex-account-3", "openai-codex"), "openai-codex-account-3");
	assert.equal(accountToKeep("openai-codex-account-2", "openai-codex"), "openai-codex-account-2");
});

test("respects an explicit account or non-Codex provider choice", () => {
	assert.equal(accountToKeep("openai-codex-account-3", "openai-codex-account-2"), undefined);
	assert.equal(accountToKeep("openai-codex-account-3", "commandcode"), undefined);
	assert.equal(accountToKeep("openai-codex", "openai-codex"), undefined);
	assert.equal(accountToKeep(undefined, "openai-codex"), undefined);
});
