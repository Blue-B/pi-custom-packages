/**
 * xai_generate_video — Grok Imagine video generation via xAI OAuth (no API key).
 *
 * Self-contained durable extension (survives `pi-xai-oauth` package updates).
 * Uses the `xai-auth` OAuth token from ~/.pi/agent/auth.json (same login the
 * Grok models use) and refreshes it via the refresh_token when expired.
 *
 * Backed by the real, confirmed endpoints:
 *   POST https://api.x.ai/v1/videos/generations   -> { request_id }
 *   GET  https://api.x.ai/v1/videos/{request_id}   -> { status, video:{url,duration} }
 *
 * Supports:
 *   - text -> video        (model grok-imagine-video)
 *   - image -> video       (pass `image`; public URL, local path, or data URI)
 *   - "Imagine 1.5"        (model grok-imagine-video-1.5-preview, image-input only)
 *
 * NOTE: the package's own constant points at /v1/video/generations which 404s;
 * the correct route is /v1/videos/generations (plural). This extension uses the
 * correct one. Image generation already works via the package's xai_generate_image.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

const AUTH_PATH = join(homedir(), ".pi", "agent", "auth.json");
const TOKEN_URL = "https://auth.x.ai/oauth2/token";
const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const VIDEOS_URL = "https://api.x.ai/v1/videos/generations";
const VIDEO_STATUS_URL = "https://api.x.ai/v1/videos"; // + /{request_id}
const REFRESH_SKEW_MS = 2 * 60 * 1000;
const POLL_INTERVAL_MS = 5_000;
const MAX_POLLS = 120; // ~10 min

const VIDEO_MODELS = ["grok-imagine-video", "grok-imagine-video-1.5-preview"];
const RESOLUTIONS = ["480p", "720p", "1080p"];
const ASPECTS = ["16:9", "9:16", "1:1"];

const TOOL_PARAMS = Type.Object({
	prompt: Type.String({
		description:
			"Description of the video / motion to generate. For image-to-video this describes how the still image should animate.",
	}),
	image: Type.Optional(
		Type.String({
			description:
				"Optional source image for image-to-video: a public https URL, a local file path, or a data:image/...;base64 URI. Required for the grok-imagine-video-1.5-preview model.",
		}),
	),
	model: Type.Optional(
		StringEnum(VIDEO_MODELS, {
			description:
				"Video model. grok-imagine-video = text or image to video. grok-imagine-video-1.5-preview = newest 'Imagine 1.5', image-input only.",
		}),
	),
	duration: Type.Optional(Type.Number({ description: "Clip length in seconds (e.g. 6-12). Default 6." })),
	aspect_ratio: Type.Optional(StringEnum(ASPECTS, { description: "Aspect ratio. Default 16:9." })),
	resolution: Type.Optional(StringEnum(RESOLUTIONS, { description: "Resolution. Default 720p." })),
	out: Type.Optional(
		Type.String({
			description:
				"Where to save the .mp4. Relative paths resolve against the session cwd. Defaults to ~/.pi/xai-video/<timestamp>.mp4.",
		}),
	),
});
type ToolParams = Static<typeof TOOL_PARAMS>;

function abs(p: string, cwd: string): string {
	return isAbsolute(p) ? p : resolve(cwd, p);
}

function parseExpiry(v: unknown): number {
	if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
	if (typeof v === "string") {
		const n = Number(v);
		if (!Number.isNaN(n)) return n < 1e12 ? n * 1000 : n;
		const d = Date.parse(v);
		if (!Number.isNaN(d)) return d;
	}
	return 0;
}

/** Load the xai-auth OAuth access token, refreshing via refresh_token when stale. */
async function resolveXaiToken(): Promise<string> {
	if (!existsSync(AUTH_PATH)) {
		throw new Error("No ~/.pi/agent/auth.json found. Log in to xAI (Grok) in pi first.");
	}
	const auth = JSON.parse(readFileSync(AUTH_PATH, "utf8"));
	const x = auth["xai-auth"];
	if (!x || (!x.access && !x.refresh)) {
		throw new Error("No xai-auth OAuth credentials in auth.json. Log in to xAI (Grok) in pi first.");
	}
	const expires = parseExpiry(x.expires);
	const fresh = x.access && expires && expires - Date.now() > REFRESH_SKEW_MS;
	if (fresh) return x.access;

	if (!x.refresh) {
		if (x.access) return x.access;
		throw new Error("xai-auth token expired and no refresh_token available. Re-login to xAI in pi.");
	}
	const res = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: x.refresh,
			client_id: CLIENT_ID,
		}).toString(),
	});
	if (!res.ok) {
		const t = await res.text().catch(() => "");
		throw new Error(`xAI token refresh failed (${res.status}). Re-login to xAI in pi. ${t.slice(0, 200)}`);
	}
	const t = await res.json();
	const access = t.access_token || t.access;
	if (!access) throw new Error("xAI token refresh returned no access_token.");
	// Persist back so other tools benefit.
	x.access = access;
	if (t.refresh_token) x.refresh = t.refresh_token;
	x.expires = Date.now() + (Number(t.expires_in) || 3600) * 1000;
	try {
		writeFileSync(AUTH_PATH, JSON.stringify(auth, null, 2));
	} catch {
		/* best-effort; token still usable in-process */
	}
	return access;
}

const IMG_MIME: Record<string, string> = {
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	webp: "image/webp",
	gif: "image/gif",
};

/** Turn the `image` param into the API's { url } shape (public URL or data URI). */
async function buildImageField(value: string, cwd: string): Promise<{ url: string }> {
	const v = value.trim();
	if (/^https?:\/\//i.test(v) || /^data:image\//i.test(v)) return { url: v };
	const path = abs(v, cwd);
	if (!existsSync(path)) {
		throw new Error(`image not found: ${v} (and not a URL or data URI)`);
	}
	const ext = path.split(".").pop()?.toLowerCase() || "png";
	const mime = IMG_MIME[ext];
	if (!mime) throw new Error(`unsupported image type .${ext}; use png/jpeg/webp/gif, a URL, or a data URI`);
	const data = (await readFile(path)).toString("base64");
	return { url: `data:${mime};base64,${data}` };
}

export default function xaiImagine(pi: ExtensionAPI) {
	pi.registerTool({
		name: "xai_generate_video",
		label: "xAI Video (Grok Imagine)",
		description:
			"Generate a video with Grok Imagine via xAI OAuth (no API key). Text-to-video or image-to-video, including the newest 'Imagine 1.5' (grok-imagine-video-1.5-preview, image-input). Returns a saved .mp4 path and the hosted URL. Async — polls until done (tens of seconds).",
		promptSnippet: "Generate video with Grok Imagine (text->video, image->video, Imagine 1.5).",
		promptGuidelines: [
			"Use for short AI video clips. Pass `image` (path/URL/data URI) for image-to-video.",
			"grok-imagine-video-1.5-preview requires an `image` (image-input only).",
			"Video generation is paid (~$0.50/sec) and takes tens of seconds; one clip per call.",
		],
		parameters: TOOL_PARAMS,
		executionMode: "parallel",
		async execute(_toolCallId, params: ToolParams, signal, onUpdate, ctx) {
			const cwd = (ctx as any)?.cwd || process.cwd();
			const model = params.model || "grok-imagine-video";
			if (model === "grok-imagine-video-1.5-preview" && !params.image) {
				throw new Error("grok-imagine-video-1.5-preview is image-input only — provide `image`.");
			}

			const outPath = params.out
				? abs(params.out, cwd)
				: join(homedir(), ".pi", "xai-video", `${Date.now()}.mp4`);
			await mkdir(join(outPath, ".."), { recursive: true });

			const token = await resolveXaiToken();

			const body: Record<string, any> = {
				model,
				prompt: params.prompt,
				duration: params.duration ?? 6,
				aspect_ratio: params.aspect_ratio ?? "16:9",
				resolution: params.resolution ?? "720p",
			};
			if (params.image) body.image = await buildImageField(params.image, cwd);

			onUpdate?.({
				content: [{ type: "text", text: `Submitting ${model} (${body.duration}s, ${body.resolution})...` }],
				details: { model, ...body, image: params.image ? "[provided]" : undefined },
			});

			const createRes = await fetch(VIDEOS_URL, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${token}`,
				},
				body: JSON.stringify(body),
				signal,
			});
			if (!createRes.ok) {
				const t = await createRes.text().catch(() => "");
				throw new Error(`xAI video create failed (${createRes.status}): ${t.slice(0, 400)}`);
			}
			const created = await createRes.json();
			const requestId = created.request_id || created.id;
			if (!requestId) throw new Error(`No request_id returned: ${JSON.stringify(created).slice(0, 300)}`);

			let videoUrl = "";
			let duration = body.duration;
			for (let i = 0; i < MAX_POLLS; i++) {
				if (signal?.aborted) throw new Error("aborted");
				await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
				const pollRes = await fetch(`${VIDEO_STATUS_URL}/${requestId}`, {
					headers: { Authorization: `Bearer ${token}` },
					signal,
				});
				const data = await pollRes.json().catch(() => ({}) as any);
				const status = data.status;
				if (status === "done") {
					videoUrl = data.video?.url || data.url;
					duration = data.video?.duration ?? duration;
					break;
				}
				if (status === "failed" || status === "expired") {
					throw new Error(`xAI video ${status}: ${JSON.stringify(data).slice(0, 300)}`);
				}
				onUpdate?.({
					content: [{ type: "text", text: `Rendering... (${(i + 1) * (POLL_INTERVAL_MS / 1000)}s, status=${status || "pending"})` }],
					details: { requestId, status, progress: data.progress },
				});
			}
			if (!videoUrl) throw new Error("Timed out waiting for video to finish.");

			// Download the mp4 to disk.
			let savedNote = "";
			try {
				const dl = await fetch(videoUrl, { signal });
				if (dl.ok) {
					const buf = Buffer.from(await dl.arrayBuffer());
					await writeFile(outPath, buf);
					savedNote = `Saved to ${outPath} (${(buf.length / 1e6).toFixed(1)} MB). `;
				} else {
					savedNote = `(Could not download — HTTP ${dl.status}. Use the URL below.) `;
				}
			} catch {
				savedNote = "(Download skipped — use the URL below.) ";
			}

			const summary = `Generated ${duration}s video with ${model}. ${savedNote}URL: ${videoUrl}`;
			return {
				content: [{ type: "text", text: summary }],
				details: { model, requestId, url: videoUrl, outPath, duration },
			};
		},
	});
}
