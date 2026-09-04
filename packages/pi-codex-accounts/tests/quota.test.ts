import assert from "node:assert/strict";
import test from "node:test";
import {
	exhaustedResetAt,
	isAccountAvailable,
} from "../extensions/codex-accounts/quota.ts";

test("uses the exhausted weekly window reset and skips unavailable accounts", () => {
	const primary = { used_percent: 0, reset_at: 1_000 };
	const secondary = { used_percent: 100, reset_at: 2_000 };

	assert.equal(exhaustedResetAt(primary, secondary), 2_000_000);
	assert.equal(
		isAccountAvailable({ allowed: false, primary, secondary }),
		false,
	);
	assert.equal(
		isAccountAvailable({
			allowed: true,
			primary: { used_percent: 11 },
			secondary: { used_percent: 2 },
		}),
		true,
	);
	assert.equal(
		isAccountAvailable({ secondary: { used_percent: 100 } }),
		false,
	);
});
