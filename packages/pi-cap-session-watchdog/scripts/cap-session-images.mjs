#!/usr/bin/env node
/**
 * cap-session-images.mjs
 * ----------------------
 * On-disk repair for a pi session .jsonl that has bloated with base64 screenshots
 * (browser / winshot / gpt-image), causing the "infinite compaction / Prompt is too
 * long during turn-prefix summarization" loop.
 *
 * It replaces stale image blocks with text placeholders, keeping ALL text /
 * tool-results / thinking intact. A full backup is written first.
 *
 * IMPORTANT: replacing payloads with a 1x1 PNG is NOT enough. pi core estimates
 * every `type: "image"` block as 50K tokens regardless of byte size during
 * compaction/model-switch preflight, so old image blocks must stop being images.
 *
 * Companion to the live extension ~/.pi/agent/extensions/cap-context-images.ts
 * (which trims images out of OUTBOUND provider requests for FUTURE turns).
 * This script cures sessions that already got too big to even load/compact.
 *
 * Usage:
 *   node cap-session-images.mjs <session.jsonl>            # repair one file
 *   node cap-session-images.mjs --dry <session.jsonl>      # report only, no write
 *   node cap-session-images.mjs --keep 3 <session.jsonl>   # keep last N images full
 *
 * Safe by design: backup -> temp -> validate -> atomic rename (mtime preserved).
 */
import fs from "node:fs";
import readline from "node:readline";

const PLACEHOLDER =
	"[older image omitted from on-disk session by cap-session-images to prevent compaction/model-switch token overestimation]";

const args = process.argv.slice(2);
let dry = false;
let keep = 0;
const files = [];
for (let i = 0; i < args.length; i++) {
	if (args[i] === "--dry") dry = true;
	else if (args[i] === "--keep") keep = parseInt(args[++i], 10) || 0;
	else files.push(args[i]);
}
if (files.length !== 1) {
	console.error(
		"usage: node cap-session-images.mjs [--dry] [--keep N] <session.jsonl>",
	);
	process.exit(2);
}
const SRC = files[0];
if (!fs.existsSync(SRC)) {
	console.error("not found:", SRC);
	process.exit(2);
}

function dataLen(v) {
	if (typeof v.data === "string") return v.data.length;
	if (v.source && typeof v.source.data === "string")
		return v.source.data.length;
	if (v.image_url && typeof v.image_url.url === "string")
		return v.image_url.url.length;
	return 0;
}
function neutralize(v) {
	const textType = v.type === "input_image" ? "input_text" : "text";
	for (const key of Object.keys(v)) delete v[key];
	v.type = textType;
	v.text = PLACEHOLDER;
}
function isImg(v) {
	return (
		v && typeof v === "object" && (v.type === "image" || v.type === "image_url")
	);
}

// pass 1: index every image block position (line, order) to support --keep N
async function run() {
	// First, count images so --keep can compute the cutoff.
	let total = 0;
	{
		const rl = readline.createInterface({
			input: fs.createReadStream(SRC),
			crlfDelay: Infinity,
		});
		for await (const line of rl) {
			if (!line.trim()) continue;
			let o;
			try {
				o = JSON.parse(line);
			} catch {
				continue;
			}
			(function c(v) {
				if (!v || typeof v !== "object") return;
				if (Array.isArray(v)) {
					v.forEach(c);
					return;
				}
				if (isImg(v)) total++;
				for (const k in v) c(v[k]);
			})(o);
		}
	}
	const cutoff = Math.max(0, total - keep); // neutralize first `cutoff` images
	if (cutoff === 0) {
		console.log(`[skip] ${SRC}`);
		console.log(`  images:${total} keep:${keep} — no stale image blocks to convert`);
		return;
	}

	const srcSize = fs.statSync(SRC).size;
	const BAK =
		SRC +
		".bak-precap-" +
		new Date().toISOString().slice(0, 10).replace(/-/g, "");
	const TMP = SRC + ".tmp-cap";
	if (!dry && !fs.existsSync(BAK)) fs.copyFileSync(SRC, BAK);

	const rl = readline.createInterface({
		input: fs.createReadStream(SRC),
		crlfDelay: Infinity,
	});
	const out = dry ? null : fs.createWriteStream(TMP);
	let inLines = 0,
		replaced = 0,
		saved = 0,
		seen = 0,
		parseErr = 0,
		usageFixed = 0; // retired: usage truthing moved to cap-session-livesize.mjs
	for await (const line of rl) {
		inLines++;
		if (!line.trim()) {
			out && out.write("\n");
			continue;
		}
		let o;
		try {
			o = JSON.parse(line);
		} catch {
			parseErr++;
			out && out.write(line + "\n");
			continue;
		}
		(function c(v) {
			if (!v || typeof v !== "object") return;
			if (Array.isArray(v)) {
				v.forEach(c);
				return;
			}
			if (isImg(v)) {
				if (seen < cutoff) {
					saved += dataLen(v);
					neutralize(v);
					replaced++;
				}
				seen++;
			}
			for (const k in v) c(v[k]);
		})(o);
		// NOTE (2026-06-16): usage metadata is NO LONGER touched here. The old flat
		// USAGE_CAP=50000 cap was one recurring landmine. A second landmine was keeping
		// old blocks as type=image after shrinking them to 1x1 PNG: pi core still counts
		// each image block as 50K tokens during model-switch/compaction preflight. So
		// stale images are converted to text placeholders, not tiny images. Usage
		// truthing lives in cap-session-livesize.mjs.
		out && out.write(JSON.stringify(o) + "\n");
	}
	if (out) await new Promise((r) => out.end(r));

	if (dry) {
		console.log(`[dry] ${SRC}`);
		console.log(
			`  lines:${inLines} images:${total} wouldNeutralize:${replaced} keep:${keep} parseErr:${parseErr}`,
		);
		console.log(
			`  base64 to remove: ${(saved / 1048576).toFixed(1)}MB of ${(srcSize / 1048576).toFixed(1)}MB`,
		);
		return;
	}

	// validate temp
	const rl2 = readline.createInterface({
		input: fs.createReadStream(TMP),
		crlfDelay: Infinity,
	});
	let v2 = 0,
		v2err = 0,
		v2img = 0;
	for await (const line of rl2) {
		v2++;
		if (!line.trim()) continue;
		let o;
		try {
			o = JSON.parse(line);
		} catch {
			v2err++;
			continue;
		}
		(function c(v) {
			if (!v || typeof v !== "object") return;
			if (Array.isArray(v)) {
				v.forEach(c);
				return;
			}
			if (isImg(v)) v2img++;
			for (const k in v) c(v[k]);
		})(o);
	}
	// Tolerate PRE-EXISTING malformed lines (e.g. NUL-corrupted lines from prior crashes):
	// only fail if we introduced NEW parse errors, lost lines, or failed to reduce image
	// blocks to the requested keep count. Old behavior kept image count unchanged by
	// replacing payloads with 1x1 PNGs; new behavior converts stale images to text.
	const expectedImages = Math.min(total, keep);
	const ok = v2 === inLines && v2err === parseErr && v2img === expectedImages;
	if (!ok) {
		console.error("VALIDATION FAILED — leaving original untouched. temp:", TMP);
		console.error(
			`  inLines:${inLines} tmpLines:${v2} v2err:${v2err} preexistingErr:${parseErr} imgIn:${total} imgOut:${v2img}`,
		);
		process.exit(1);
	}
	const mtime = fs.statSync(SRC).mtime;
	fs.renameSync(TMP, SRC);
	fs.utimesSync(SRC, mtime, mtime);
	const newSize = fs.statSync(SRC).size;
	console.log(`[ok] ${SRC}`);
	console.log(
		`  ${(srcSize / 1048576).toFixed(1)}MB -> ${(newSize / 1048576).toFixed(2)}MB | images:${total} neutralized:${replaced} kept:${keep} usageFixed:${usageFixed}`,
	);
	console.log(`  backup: ${BAK}`);
}
run().catch((e) => {
	console.error(e);
	process.exit(1);
});
