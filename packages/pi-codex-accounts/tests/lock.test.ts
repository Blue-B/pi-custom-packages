import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { withFileLock } from "../extensions/codex-accounts/lock.ts";

test("concurrent read-modify-write under the lock loses no updates", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-lock-"));
	const file = path.join(dir, "usage.json");
	await fs.writeFile(file, "0");
	const bump = async () => {
		const n = Number(await fs.readFile(file, "utf8"));
		await new Promise((r) => setTimeout(r, 1));
		await fs.writeFile(file, String(n + 1));
	};
	await Promise.all(
		Array.from({ length: 25 }, () => withFileLock(file, bump)),
	);
	assert.equal(await fs.readFile(file, "utf8"), "25");
	await assert.rejects(fs.stat(`${file}.lock`));
	await fs.rm(dir, { recursive: true, force: true });
});

test("stale lock from a dead holder is reclaimed", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-lock-"));
	const file = path.join(dir, "usage.json");
	await fs.mkdir(`${file}.lock`);
	const old = new Date(Date.now() - 60_000);
	await fs.utimes(`${file}.lock`, old, old);
	assert.equal(await withFileLock(file, async () => "ok"), "ok");
	await fs.rm(dir, { recursive: true, force: true });
});
