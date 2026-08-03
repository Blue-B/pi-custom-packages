#!/usr/bin/env node
// cap-session-livesize.mjs
// ---------------------------------------------------------------------------
// Single authority for SESSION USAGE TRUTH + LIVE-CONTEXT SIZE.
//
// Root cause of the recurring infinite-compaction saga (8 variants up to
// 2026-06-16): the usage metadata pi reads to decide compaction drifts away
// from the real live-context size. Two directions, both fatal:
//   * stale-HIGH  (e.g. cacheRead=865000 left over from an image-heavy era):
//     pi thinks the session is near-full, compacts pointlessly, loops.
//   * stale-LOW   (e.g. cacheRead pinned to 50000 by the old image-cap hack):
//     pi thinks the session is nearly empty, NEVER compacts proactively, the
//     live context grows silently until it overflows a model window (or a
//     model switch to a smaller window) and loops.
//
// This tool measures the metric pi actually cares about -- live-context tokens
// (last compaction summary + kept messages) -- and:
//   1. USAGE TRUTH (always): rewrites the last assistant message's usage so its
//      cacheRead/totalTokens reflect the REAL live-context estimate. This makes
//      pi's native compaction fire correctly, which is what keeps BIG sessions
//      healthy without ever entering a loop.
//   2. SIZE TRIM (only when real live > CEILING): relocates the compaction
//      boundary forward to the newest clean user-prompt boundary that leaves a
//      tail of about TARGET_TAIL tokens, by appending a synthetic `compaction`
//      record (exactly what pi's own end-of-turn compaction writes).
//
// SAFE BY DESIGN:
//   * dry-run is the DEFAULT. Pass --apply to write.
//   * only touches sessions that already have a compaction record.
//   * never cuts inside a tool_use/tool_result pair (boundary = user prompt
//     with text and no tool_result; kept window verified orphan-free).
//   * every untouched line is preserved byte-for-byte; only the last assistant
//     message line is rewritten and (on trim) one compaction line appended.
//   * backup -> validate-every-line -> atomic rename, mtime preserved.
//   * idempotent: a healthy + already-truthful session is a no-op.
//
// USAGE:
//   node cap-session-livesize.mjs --all                 # dry-run every session
//   node cap-session-livesize.mjs --all --apply         # heal every session
//   node cap-session-livesize.mjs <file.jsonl> [--apply]
//
// ENV:
//   PI_LIVESIZE_CEILING     live-token ceiling that triggers a trim (default 280000)
//   PI_LIVESIZE_TARGET      target tail tokens to keep after trim   (default 150000)
//   PI_LIVESIZE_USAGE_TOL   only rewrite usage if it is off by more than this (default 25000)
//   PI_LIVESIZE_MIN_MTIME   idle guard: skip files modified within N seconds (default 0 = off)
//   PI_LIVESIZE_MIN_FILE_MB stat prefilter for --all (default 3)
// ---------------------------------------------------------------------------

import {
	readFileSync,
	writeFileSync,
	copyFileSync,
	renameSync,
	statSync,
	utimesSync,
	readdirSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const HOME = homedir();
const SESS_DIR = join(HOME, ".pi", "agent", "sessions");
const CEILING = Number(process.env.PI_LIVESIZE_CEILING) || 280000;
const TARGET_TAIL = Number(process.env.PI_LIVESIZE_TARGET) || 150000;
const USAGE_TOL = Number(process.env.PI_LIVESIZE_USAGE_TOL) || 25000;
const MIN_MTIME = Number(process.env.PI_LIVESIZE_MIN_MTIME) || 0;
const MIN_FILE_MB = Number(process.env.PI_LIVESIZE_MIN_FILE_MB) || 3;

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const ALL = args.includes("--all");
const files = args.filter((a) => !a.startsWith("--"));

function estTokens(o) {
	const m = o.message;
	if (!m) return 0;
	const c = m.content;
	if (typeof c === "string") return Math.ceil(c.length / 4);
	if (!Array.isArray(c)) return 0;
	let n = 0;
	for (const b of c) {
		if (
			b.type === "image" ||
			b.type === "image_url" ||
			b.type === "input_image"
		)
			n += 50000;
		else if (b.type === "thinking")
			n += Math.ceil((b.thinking || "").length / 4);
		else if (b.type === "text") n += Math.ceil((b.text || "").length / 4);
		else if (b.type === "tool_use")
			n += Math.ceil(JSON.stringify(b.input || {}).length / 4) + 10;
		else if (b.type === "tool_result")
			n += Math.ceil(JSON.stringify(b.content || "").length / 4) + 10;
		else n += Math.ceil(JSON.stringify(b).length / 4);
	}
	return n;
}

function isUserPrompt(o) {
	const m = o.message;
	if (!m || m.role !== "user") return false;
	const c = m.content;
	if (typeof c === "string") return c.trim().length > 0;
	if (!Array.isArray(c)) return false;
	const hasText = c.some((b) => b.type === "text" && (b.text || "").trim());
	const hasToolResult = c.some((b) => b.type === "tool_result");
	return hasText && !hasToolResult;
}

// Build a plan describing what (if anything) to change. Returns { skip } or a plan.
function plan(file) {
	const raw = readFileSync(file, "utf8");
	const rawLines = raw.split("\n");
	const objs = [];
	const lineIdxOfObj = [];
	for (let i = 0; i < rawLines.length; i++) {
		const ln = rawLines[i];
		if (!ln.trim()) continue;
		try {
			objs.push(JSON.parse(ln));
			lineIdxOfObj.push(i);
		} catch {
			/* skip */
		}
	}
	const comps = objs.filter((o) => o.type === "compaction");
	if (!comps.length) return { skip: "no-compaction-record" };
	const last = comps[comps.length - 1];
	const startIdx = objs.findIndex((o) => o.id === last.firstKeptEntryId);
	if (startIdx < 0) return { skip: "firstKept-not-found" };
	const summaryTok = Math.ceil((last.summary || "").length / 4);
	const live = objs.slice(startIdx);
	let realLive = summaryTok;
	for (const o of live) if (o.type === "message") realLive += estTokens(o);

	// ---- decide trim ----
	let trimRec = null,
		effectiveLive = realLive,
		boundaryTs = null;
	if (realLive > CEILING) {
		const tailTok = new Array(live.length).fill(0);
		let cum = 0;
		for (let i = live.length - 1; i >= 0; i--) {
			cum += live[i].type === "message" ? estTokens(live[i]) : 0;
			tailTok[i] = cum;
		}
		let pick = -1;
		for (let i = 0; i < live.length; i++)
			if (isUserPrompt(live[i]) && tailTok[i] <= TARGET_TAIL) {
				pick = i;
				break;
			}
		if (pick < 0)
			for (let i = live.length - 1; i >= 0; i--)
				if (isUserPrompt(live[i])) {
					pick = i;
					break;
				}
		if (pick < 0) return { skip: "no-clean-boundary", realLive };
		const boundary = live[pick];
		const kept = live.slice(pick);
		const toolUse = new Set();
		for (const o of kept) {
			const m = o.message;
			if (m && Array.isArray(m.content))
				for (const b of m.content) if (b.type === "tool_use") toolUse.add(b.id);
		}
		for (const o of kept) {
			const m = o.message;
			if (m && Array.isArray(m.content))
				for (const b of m.content)
					if (b.type === "tool_result" && !toolUse.has(b.tool_use_id))
						return { skip: "orphan-at-boundary", realLive };
		}
		effectiveLive = summaryTok + tailTok[pick];
		boundaryTs = boundary.timestamp;
		const used = new Set(objs.map((o) => o.id));
		let nid;
		do {
			nid = Math.floor(Math.random() * 0xffffffff)
				.toString(16)
				.padStart(8, "0");
		} while (used.has(nid));
		const note = `\n\n---\n## [auto livesize-trim ${new Date().toISOString().slice(0, 16)}] live ${Math.round(realLive / 1000)}K -> ~${Math.round(effectiveLive / 1000)}K
Earlier turns are preserved in the summary above. The compaction boundary was advanced to ${boundaryTs} to prevent infinite re-compaction caused by reported-usage vs actual-content mismatch.
`;
		const rec = {
			type: "compaction",
			id: nid,
			parentId: objs[objs.length - 1].id,
			timestamp: new Date().toISOString(),
			summary: (last.summary || "") + note,
			firstKeptEntryId: boundary.id,
			tokensBefore: realLive,
			details: { readFiles: [], modifiedFiles: [] },
			fromHook: false,
		};
		trimRec = JSON.stringify(rec);
	}

	// ---- decide usage truth (last assistant message) ----
	// CONSERVATIVE: a provider-reported usage number is generally MORE accurate
	// than our chars/4 estimate, so we never override a genuine provider value
	// (overriding DOWN with an under-estimate would re-create the silent-growth
	// trap). We only rewrite usage when it is provably NOT a real provider value:
	//   (a) the artificial cap landmine: cacheRead === EXACTLY 50000, or
	//   (b) a trim just changed the real live size out from under it.
	let usageEdit = null;
	let lastAsstRaw = -1,
		lastAsstObj = null;
	for (let k = objs.length - 1; k >= 0; k--) {
		const m = objs[k].message;
		if (m && m.role === "assistant" && m.usage) {
			lastAsstRaw = lineIdxOfObj[k];
			lastAsstObj = objs[k];
			break;
		}
	}
	if (lastAsstObj) {
		const u = lastAsstObj.message.usage;
		const cur = u.cacheRead || 0;
		const isLandmine = cur === 50000; // exact cap signature from the retired cap-session-images hack
		const desired = effectiveLive; // truthful: cached prompt prefix ~= live context
		if ((trimRec || isLandmine) && Math.abs(cur - desired) > USAGE_TOL) {
			const nu = { ...u };
			nu.cacheRead = desired;
			nu.input = Math.min(u.input || 0, 2000);
			nu.totalTokens =
				(nu.input || 0) + (u.output || 0) + desired + (u.cacheWrite || 0);
			const clone = JSON.parse(JSON.stringify(lastAsstObj));
			clone.message.usage = nu;
			usageEdit = {
				rawIdx: lastAsstRaw,
				line: JSON.stringify(clone),
				from: cur,
				to: desired,
			};
		}
	}

	if (!trimRec && !usageEdit) return { skip: "healthy", realLive };
	return {
		raw,
		rawLines,
		realLive,
		effectiveLive,
		boundaryTs,
		trimRec,
		usageEdit,
	};
}

function apply(file, p) {
	const st = statSync(file);
	const bak =
		file +
		".bak-livesize-" +
		new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
	copyFileSync(file, bak);
	const lines = p.rawLines.slice();
	if (p.usageEdit) lines[p.usageEdit.rawIdx] = p.usageEdit.line;
	// trailing newline handling: rawLines from split already models the final newline as a trailing "".
	let out = lines.join("\n");
	if (p.trimRec) {
		if (!out.endsWith("\n")) out += "\n";
		out += p.trimRec + "\n";
	}
	let bad = 0;
	for (const ln of out.split("\n")) {
		if (!ln.trim()) continue;
		try {
			JSON.parse(ln);
		} catch {
			bad++;
		}
	}
	if (bad) throw new Error("validation failed: " + bad + " bad lines");
	const tmp = file + ".tmp-livesize";
	writeFileSync(tmp, out);
	renameSync(tmp, file);
	try {
		utimesSync(file, st.atime, st.mtime);
	} catch {}
	return bak.split("/").pop();
}

function collectAll() {
	const out = [];
	let dirs;
	try {
		dirs = readdirSync(SESS_DIR, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const d of dirs) {
		if (!d.isDirectory()) continue;
		const sub = join(SESS_DIR, d.name);
		for (const f of readdirSync(sub)) {
			if (!f.endsWith(".jsonl")) continue;
			const pth = join(sub, f);
			try {
				if (statSync(pth).size < MIN_FILE_MB * 1024 * 1024) continue;
			} catch {
				continue;
			}
			out.push(pth);
		}
	}
	return out;
}

const targets = ALL ? collectAll() : files;
if (!targets.length) {
	console.log(
		"usage: cap-session-livesize.mjs (--all | <file.jsonl>) [--apply]",
	);
	process.exit(1);
}

console.log(
	`mode=${APPLY ? "APPLY" : "DRY-RUN"} ceiling=${CEILING} target=${TARGET_TAIL} tol=${USAGE_TOL} files=${targets.length}\n`,
);
let acted = 0,
	healed = 0;
for (const file of targets) {
	let p;
	try {
		p = plan(file);
	} catch (e) {
		console.log("ERR ", file.split("/").pop(), e.message);
		continue;
	}
	if (p.skip === "healthy" || p.skip === "no-compaction-record") continue;
	if (p.skip) {
		console.log(
			`skip[${p.skip}] live=${p.realLive || "?"} ${file.split("/").pop()}`,
		);
		continue;
	}
	acted++;
	if (MIN_MTIME > 0) {
		const ageSec = (Date.now() - statSync(file).mtimeMs) / 1000;
		if (ageSec < MIN_MTIME) {
			console.log(
				`ACTIVE skip (age ${Math.round(ageSec)}s) live=${p.realLive} ${file.split("/").pop()}`,
			);
			continue;
		}
	}
	const what = [];
	if (p.trimRec)
		what.push(
			`TRIM ${Math.round(p.realLive / 1000)}K->~${Math.round(p.effectiveLive / 1000)}K @${p.boundaryTs}`,
		);
	if (p.usageEdit)
		what.push(
			`USAGE ${p.usageEdit.from.toLocaleString()}->${p.usageEdit.to.toLocaleString()}`,
		);
	console.log(`${what.join("  ")}  ${file.split("/").pop()}`);
	if (APPLY) {
		try {
			const bak = apply(file, p);
			healed++;
			console.log(`   APPLIED backup=${bak}`);
		} catch (e) {
			console.log("   FAILED:", e.message);
		}
	}
}
console.log(
	`\nactionable: ${acted}  ${APPLY ? "healed: " + healed : "(dry-run, pass --apply)"}`,
);
