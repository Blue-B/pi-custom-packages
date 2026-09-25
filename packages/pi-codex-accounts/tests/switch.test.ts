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

test("never falls back to an unintended model", () => {
	// 폴백하면 사용자가 더 낮은 모델로 잘못 호출됐는지 알 수 없다.
	// 유지할 수 없으면 undefined를 반환하고 호출부가 계정 전환을 중단한다.
	const foreign = { provider: "commandcode", id: "deepseek/deepseek-v4.1-flash" };

	assert.equal(modelForAccount("openai-codex-account-2", undefined, undefined), undefined);
	assert.equal(modelForAccount("openai-codex-account-2", foreign, undefined), undefined);
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
