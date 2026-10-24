import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PLACEHOLDER, pruneOldImages } from "../extensions/prune-old-images/index.ts";

const image = { type: "image", mimeType: "image/png", data: "A".repeat(1000) };
const msg = (id, parentId, content) => ({ type: "message", id, parentId, message: { role: "toolResult", content } });

function setup(entries) {
	const file = join(mkdtempSync(join(tmpdir(), "prune-")), "s.jsonl");
	const fileEntries = [{ type: "session", id: "h" }, ...entries];
	writeFileSync(file, fileEntries.map((e) => `${JSON.stringify(e)}\n`).join(""));
	const sm = { fileEntries, getSessionFile: () => file, getBranch: () => entries };
	return { sm, file };
}

test("drops images before the kept point, keeps the rest, and is idempotent", () => {
	const old = msg("a", null, [{ type: "text", text: "shot" }, { ...image }]);
	const kept = msg("b", "a", [{ ...image }]);
	const compaction = { type: "compaction", id: "c", parentId: "b", firstKeptEntryId: "b", summary: "s" };
	const { sm, file } = setup([old, kept, compaction]);

	assert.equal(pruneOldImages(sm), 1);
	assert.deepEqual(old.message.content, [{ type: "text", text: "shot" }, { type: "text", text: PLACEHOLDER }]);
	assert.equal(kept.message.content[0].type, "image");

	const onDisk = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
	assert.equal(onDisk.length, 4);
	assert.equal(onDisk[1].message.content[1].text, PLACEHOLDER);
	assert.equal(onDisk[2].message.content[0].type, "image");

	assert.equal(pruneOldImages(sm), 0);
});

test("does nothing without a compaction or without the expected internals", () => {
	const entries = [msg("a", null, [{ ...image }])];
	const { sm } = setup(entries);
	assert.equal(pruneOldImages(sm), 0);

	const compacted = [msg("a", null, [{ ...image }]), { type: "compaction", id: "c", parentId: "a", firstKeptEntryId: "c" }];
	assert.equal(pruneOldImages({ getSessionFile: () => "/x", getBranch: () => compacted }), 0);
	assert.equal(compacted[0].message.content[0].type, "image");
	assert.equal(pruneOldImages(undefined), 0);
});
