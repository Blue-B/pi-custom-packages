import { closeSync, openSync, renameSync, writeSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Images before the latest compaction's kept point are no longer sent to the model,
// but pi keeps them in memory and in the session file forever. Drop them.
export const PLACEHOLDER = "[image removed after compaction]";

export function pruneOldImages(sm: any): number {
	// shortcut: relies on SessionManager internals (fileEntries, live entry objects), checked on pi 1.4.0;
	// if they change, do nothing rather than leave memory and file out of sync.
	const file = sm?.getSessionFile?.();
	if (!file || !Array.isArray(sm.fileEntries) || typeof sm.getBranch !== "function") return 0;

	const branch = sm.getBranch();
	let keepIdx = -1;
	for (let i = branch.length - 1; i >= 0; i--) {
		if (branch[i].type === "compaction") {
			keepIdx = branch.findIndex((e: any) => e.id === branch[i].firstKeptEntryId);
			break;
		}
	}
	if (keepIdx <= 0) return 0;

	let removed = 0;
	for (const entry of branch.slice(0, keepIdx)) {
		const content = entry.type === "message" ? entry.message?.content : undefined;
		if (!Array.isArray(content)) continue;
		for (let i = 0; i < content.length; i++) {
			if (content[i]?.type === "image") {
				content[i] = { type: "text", text: PLACEHOLDER };
				removed++;
			}
		}
	}
	if (removed === 0) return 0;

	// Entries are mutated in place, so memory is freed too; rewrite the file atomically.
	const tmp = `${file}.prune-tmp`;
	const fd = openSync(tmp, "w");
	try {
		for (const e of sm.fileEntries) writeSync(fd, `${JSON.stringify(e)}\n`);
	} finally {
		closeSync(fd);
	}
	renameSync(tmp, file);
	return removed;
}

export default function (pi: ExtensionAPI) {
	const run = (ctx: any) => {
		try {
			const n = pruneOldImages(ctx.sessionManager);
			if (n > 0) ctx.ui?.notify?.(`old images pruned: ${n}`, "info");
		} catch (err) {
			ctx.ui?.notify?.(`image prune failed: ${err}`, "warning");
		}
	};
	pi.on("session_start", (_e, ctx) => run(ctx));
	pi.on("session_compact", (_e, ctx) => run(ctx));
}
