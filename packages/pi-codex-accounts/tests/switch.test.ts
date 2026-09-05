import assert from "node:assert/strict";
import test from "node:test";
import { modelForAccount } from "../extensions/codex-accounts/model.ts";

test("keeps a custom Codex model when switching accounts", () => {
	const current = {
		provider: "openai-codex",
		id: "gpt-6-astra",
		api: "openai-codex-responses",
	};
	const spark = { ...current, provider: "openai-codex-account-2", id: "gpt-5.3-codex-spark" };

	assert.deepEqual(
		modelForAccount("openai-codex-account-2", current, undefined, spark),
		{ ...current, provider: "openai-codex-account-2" },
	);
});
