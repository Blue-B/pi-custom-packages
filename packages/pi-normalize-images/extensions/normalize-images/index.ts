import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

/**
 * normalize-images
 *
 * Provider-agnostic image guard that runs at the `context` hook (typed
 * AgentMessage[], stable {type:"image",data,mimeType} shape) before EVERY LLM
 * call. It re-encodes + downscales every image that exceeds a byte floor and,
 * crucially, REPLACES images ffmpeg cannot decode with a text placeholder.
 *
 * WHY (Shell@WSL, 2026-06-05):
 *   openai-codex (ChatGPT OAuth) has NO image-aware context management and NO
 *   downscaling (claude-bridge has its own; codex does not). Two failure modes
 *   were recurring when switching to gpt:
 *     1. "The image data you provided does not represent a valid image"
 *        -> a corrupt / truncated / unsupported screenshot or generated image.
 *     2. WebSocket 1009 "message too big" / oversized payloads from replaying
 *        full-res screenshots every turn (transport:sse already removes the WS
 *        1009 path, but payload bloat still drains the 272K window).
 *   Re-encoding through ffmpeg normalizes (1): a valid decode produces a clean
 *   JPEG, and an undecodable image is swapped for a placeholder instead of
 *   reaching the provider and hard-failing the turn. Bounding the long edge to
 *   1568px shrinks the wire payload ~15x, mitigating (2) and reducing how much
 *   the session has to compact later.
 *
 * This complements cap-context-images.ts (which DROPS stale older images at
 * before_provider_request). This one NORMALIZES the images that survive — in
 * particular the most-recent image cap-context-images keeps at full res.
 *
 * On-disk session JSONL is never modified (emitContext clones first). Never
 * throws — any failure returns the original image so a paste can't brick a turn.
 *
 * Env:
 *   PI_IMG_MAX_EDGE        long-edge cap in px (default 1568)
 *   PI_IMG_MIN_BYTES       skip images smaller than this (default 80KB)
 *                          Raised coverage 2026-07-06: was 200KB. A 161KB
 *                          full-page browser PNG slipped under the old floor,
 *                          stayed uncompressed, and (kept by cap-context-images
 *                          as the most-recent image) bloated every turn ->
 *                          "Prompt is too long". 80KB closes the 100-200KB gap.
 *   PI_IMG_QUALITY         ffmpeg -q:v (default 5; lower = better quality)
 *   PI_IMG_NORMALIZE_OFF=1 disable entirely
 */

const MAX_EDGE = Number(process.env.PI_IMG_MAX_EDGE) || 1568;
const MIN_BYTES = Number(process.env.PI_IMG_MIN_BYTES) || 80 * 1024;
const QUALITY = String(Number(process.env.PI_IMG_QUALITY) || 5);
const DISABLED = process.env.PI_IMG_NORMALIZE_OFF === "1";

const FFMPEG: string | null = (() => {
	for (const p of [join(homedir(), ".local", "bin", "ffmpeg"), "ffmpeg"]) {
		try {
			execFileSync(p, ["-version"], { stdio: "ignore" });
			return p;
		} catch {
			/* try next */
		}
	}
	return null;
})();

const PLACEHOLDER =
	"[image removed by normalize-images: the data could not be decoded as a valid image (corrupt/unsupported) and would have failed the provider]";

type ImageBlock = { type: "image"; data?: string; mimeType?: string };
type TextBlock = { type: "text"; text: string };
type Cached = { ok: true; data: string; mimeType: string } | { ok: false };

// Keyed by sha1 of the ORIGINAL base64 so each unique image is processed once
// per process instead of re-encoded every turn (emitContext re-clones from the
// session each call). Simple FIFO bound to keep memory flat on long sessions.
const cache = new Map<string, Cached>();
const CACHE_MAX = 256;

function approxBytes(b64: string): number {
	return Math.floor((b64?.length ?? 0) * 3) >> 2;
}

function extFor(mime: string): string {
	if (mime.includes("png")) return "png";
	if (mime.includes("webp")) return "webp";
	if (mime.includes("gif")) return "gif";
	if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
	return "bin";
}

function processImage(b64: string, mimeType: string): Cached {
	const key = createHash("sha1").update(b64).digest("hex");
	const hit = cache.get(key);
	if (hit) return hit;

	let result: Cached;
	if (!FFMPEG) {
		result = { ok: true, data: b64, mimeType }; // can't process; pass through
	} else {
		const dir = mkdtempSync(join(tmpdir(), "pi-img-"));
		const inp = join(dir, `in.${extFor(mimeType)}`);
		const out = join(dir, "out.jpg");
		try {
			writeFileSync(inp, Buffer.from(b64, "base64"));
			execFileSync(
				FFMPEG,
				[
					"-y",
					"-loglevel",
					"error",
					"-i",
					inp,
					"-vf",
					`scale=w=min(${MAX_EDGE}\\,iw):h=min(${MAX_EDGE}\\,ih):force_original_aspect_ratio=decrease`,
					"-q:v",
					QUALITY,
					out,
				],
				{ stdio: ["ignore", "ignore", "pipe"] },
			);
			const buf = readFileSync(out);
			if (buf.length > 0) {
				result = {
					ok: true,
					data: buf.toString("base64"),
					mimeType: "image/jpeg",
				};
			} else {
				result = { ok: false }; // decoded to nothing -> treat as corrupt
			}
		} catch {
			// ffmpeg could not decode -> the provider would reject it too. Drop it.
			result = { ok: false };
		} finally {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		}
	}

	if (cache.size >= CACHE_MAX) {
		const first = cache.keys().next().value;
		if (first !== undefined) cache.delete(first);
	}
	cache.set(key, result);
	return result;
}

export default function (pi: ExtensionAPI) {
	if (DISABLED) return;

	pi.on("context", (event) => {
		let mutated = false;
		const messages = event.messages.map((msg: any) => {
			const content = msg?.content;
			if (!Array.isArray(content)) return msg;
			let blockChanged = false;
			const newContent = content.map(
				(block: any): ImageBlock | TextBlock | any => {
					if (
						!block ||
						block.type !== "image" ||
						typeof block.data !== "string"
					)
						return block;
					if (approxBytes(block.data) <= MIN_BYTES) return block; // small: leave alone
					const r = processImage(
						block.data,
						String(block.mimeType ?? "image/png"),
					);
					if (!r.ok) {
						blockChanged = true;
						return { type: "text", text: PLACEHOLDER } as TextBlock;
					}
					if (r.data === block.data && r.mimeType === block.mimeType)
						return block;
					blockChanged = true;
					return {
						type: "image",
						data: r.data,
						mimeType: r.mimeType,
					} as ImageBlock;
				},
			);
			if (!blockChanged) return msg;
			mutated = true;
			return { ...msg, content: newContent };
		});
		if (mutated) return { messages };
		return undefined;
	});
}
