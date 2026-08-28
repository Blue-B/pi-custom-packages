#!/usr/bin/env node
// patch-image-resize-limit — shrink pi's per-image base64 ceiling at ingest.
//
// pi's image-resize-core.js ships DEFAULT_MAX_BYTES = 4.5MB, sized against
// Anthropic's 5MB *per-image* limit. The limit that actually bites first is the
// 32MB *per-request* one: a handful of full-page screenshots at 4.5MB each blow
// past it, and the session is then unsendable AND uncompactable (image bytes
// barely register as tokens, so the compactor reports "session too small").
//
// This rewrites the two defaults to 2MB / quality 88 and makes both tunable at
// runtime via PI_IMAGE_MAX_MB and PI_IMAGE_JPEG_QUALITY. Idempotent: re-running
// after a `pi update` re-applies it, and a no-op if already patched.
//
// Usage:
//   node patch-image-resize-limit.mjs [target.js] [--check]
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const MARKER = "PI_IMAGE_MAX_MB";
const REL = "@earendil-works/pi-coding-agent/dist/utils/image-resize-core.js";

// node lives at <prefix>/bin/node; globals at <prefix>/lib/node_modules.
function resolveTarget() {
	const fromArgv = process.argv.find((a) => a.endsWith(".js"));
	if (fromArgv) return fromArgv;
	const candidates = [
		process.env.PI_CORE_ROOT && join(process.env.PI_CORE_ROOT, REL),
		join(dirname(dirname(process.execPath)), "lib", "node_modules", REL),
	].filter(Boolean);
	return candidates.find((p) => existsSync(p)) ?? candidates[candidates.length - 1];
}

const TARGET = resolveTarget();
const CHECK_ONLY = process.argv.includes("--check");

if (!existsSync(TARGET)) {
	console.error(`anchor not found: missing target ${TARGET}`);
	process.exit(1);
}

let src = readFileSync(TARGET, "utf8");

if (src.includes(MARKER)) {
	console.log(`already patched: ${TARGET}`);
	process.exit(0);
}
if (CHECK_ONLY) {
	console.log(`not patched: ${TARGET}`);
	process.exit(1);
}

const BYTES_FROM = "const DEFAULT_MAX_BYTES = 4.5 * 1024 * 1024;";
const BYTES_TO =
	"const DEFAULT_MAX_BYTES = (Number(process.env.PI_IMAGE_MAX_MB) || 2) * 1024 * 1024;";
const QUALITY_FROM = "jpegQuality: 80,";
const QUALITY_TO = "jpegQuality: Number(process.env.PI_IMAGE_JPEG_QUALITY) || 88,";

if (!src.includes(BYTES_FROM) || !src.includes(QUALITY_FROM)) {
	console.error("anchor not found: DEFAULT_MAX_BYTES / jpegQuality in image-resize-core.js");
	process.exit(1);
}

copyFileSync(TARGET, `${TARGET}.bak-image-limit`);
src = src.replace(BYTES_FROM, BYTES_TO).replace(QUALITY_FROM, QUALITY_TO);
writeFileSync(TARGET, src);
console.log(`patched: ${TARGET} (2MB per image, jpeg q88)`);
