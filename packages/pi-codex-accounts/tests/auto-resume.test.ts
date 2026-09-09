import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	claimAutoResume,
	releaseAutoResume,
} from "../extensions/codex-accounts/auto-resume.ts";

test("only one session owns auto-resume until release or expiry", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-auto-resume-"));
	const lease = path.join(dir, "lease.json");

	assert.equal(await claimAutoResume(lease, "session-a", 1_000, 100), true);
	assert.equal(await claimAutoResume(lease, "session-b", 1_000, 200), false);
	assert.equal(await claimAutoResume(lease, "session-a", 1_000, 200), true);
	await releaseAutoResume(lease, "session-b");
	assert.equal(await claimAutoResume(lease, "session-b", 1_000, 300), false);
	await releaseAutoResume(lease, "session-a");
	assert.equal(await claimAutoResume(lease, "session-b", 1_000, 300), true);
	assert.equal(await claimAutoResume(lease, "session-c", 1_000, 1_301), true);

	await fs.rm(dir, { recursive: true, force: true });
});
