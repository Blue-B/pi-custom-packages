/**
 * gpt_img — txt2img + img2img via ChatGPT/Codex OAuth backend (requests gpt-image-2.5-sunburst).
 *
 * Primary path: the Codex app's native image endpoints (/backend-api/codex/images/{generations,edits}),
 * which honour `background: "transparent"` (real RGBA cut-outs). The server picks the image model for a
 * ChatGPT plan (reported as gpt-image-2-codex; model/size/quality fields are ignored), so the newest
 * ChatGPT Images model is whatever OpenAI serves there. Fallback: Responses API image_generation tool.
 *
 * Self-contained: no external custom package dependency.
 * Replicates the logic from the user's custom gptimage_oauth (for img2img support via input_image).
 * Uses the openai-codex token from ~/.pi/agent/auth.json (same as codex tools).
 *
 * Supports reference images for img2img (character-consistent edits).
 * Can be used even if the Downloads/gptimage folder is deleted.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import * as https from "node:https";

const FORMATS = ["png", "jpeg", "webp"];
const BACKGROUNDS = ["auto", "opaque", "transparent"];
const TIMEOUT_MS = 600_000;
// Quality/size are chosen server-side from the prompt on ChatGPT plans (tested: request values ignored).
const IMAGE_MODEL = "gpt-image-2.5-sunburst";

// Embed downscale — same philosophy as winshot: keep the full-res file on disk,
// shrink the base64 block that enters the session/provider payload (a full-res
// PNG here can be 1-2MB+ and bloats the .jsonl / provider request every turn).
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
const EMBED_MAX_EDGE = Number(process.env.GPTIMG_EMBED_MAX_EDGE) || 1568;
const EMBED_DOWNSCALE =
	process.env.GPTIMG_NO_DOWNSCALE !== "1" && FFMPEG !== null;

async function downscaleForEmbed(
	bytes: Buffer,
): Promise<{ bytes: Buffer; mimeType: string } | null> {
	if (!EMBED_DOWNSCALE) return null;
	const out = join(
		tmpdir(),
		`gptimg_embed_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jpg`,
	);
	const inTmp = join(
		tmpdir(),
		`gptimg_embed_in_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
	);
	try {
		await import("node:fs/promises").then((fs) => fs.writeFile(inTmp, bytes));
		execFileSync(
			FFMPEG!,
			[
				"-y",
				"-loglevel",
				"error",
				"-i",
				inTmp,
				"-vf",
				`scale=w=min(${EMBED_MAX_EDGE}\\,iw):h=min(${EMBED_MAX_EDGE}\\,ih):force_original_aspect_ratio=decrease`,
				"-q:v",
				"5",
				out,
			],
			{ stdio: ["ignore", "ignore", "ignore"] },
		);
		const buf = await readFile(out);
		return { bytes: buf, mimeType: "image/jpeg" };
	} catch {
		// Never brick generation: fall back to the original on any ffmpeg failure.
		return null;
	} finally {
		try {
			const fs = await import("node:fs/promises");
			await fs.unlink(out);
			await fs.unlink(inTmp);
		} catch {
			/* ignore */
		}
	}
}

const TOOL_PARAMS = Type.Object({
	prompt: Type.String({
		description:
			"Image prompt. Be specific about subject, composition, style, text, and constraints.",
	}),
	images: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Reference image paths. If provided, runs img2img (edit) — keeps the referenced character/scene; otherwise runs txt2img (generate).",
		}),
	),
	out: Type.Optional(
		Type.String({
			description:
				"Output image path. Relative paths resolve against the session cwd. Defaults to ~/.pi/gptimg/<timestamp>.<format>.",
		}),
	),
	format: Type.Optional(StringEnum(FORMATS)),
	background: Type.Optional(
		StringEnum(BACKGROUNDS, {
			description:
				"transparent = RGBA PNG cut-out (e.g. a character part with no background); default auto.",
		}),
	),
	dryRun: Type.Optional(
		Type.Boolean({
			description:
				"Build the request only; do not call the backend (no quota used).",
		}),
	),
});
type ToolParams = Static<typeof TOOL_PARAMS>;

function mimeForFormat(format: string): string {
	if (format === "jpeg") return "image/jpeg";
	if (format === "webp") return "image/webp";
	return "image/png";
}

function abs(p: string, cwd: string): string {
	return isAbsolute(p) ? p : resolve(cwd, p);
}

async function loadCodexAuth(): Promise<{ token: string; accountId: string }> {
	const authPath = join(homedir(), ".pi", "agent", "auth.json");
	const raw = await readFile(authPath, "utf8");
	let data: any;
	try {
		data = JSON.parse(raw);
	} catch {
		throw new Error(`auth.json is not valid JSON: ${authPath}`);
	}
	const entry = data["openai-codex"] || data["openai-account-3"] || data["codex"] || {};
	const token = entry.access || entry.token;
	const accountId = entry.accountId || entry.account_id;
	if (!token) {
		throw new Error(
			"No openai-codex access token found in ~/.pi/agent/auth.json. Log in via pi first.",
		);
	}
	return { token, accountId: accountId || "" };
}

async function imageToDataUri(path: string): Promise<string> {
	const buf = await readFile(path);
	const ext = path.split(".").pop()?.toLowerCase() || "png";
	const mime = mimeForFormat(ext);
	return `data:${mime};base64,${buf.toString("base64")}`;
}

type ImageMeta = { endpoint: string; quality?: string; size?: string; background?: string; limit?: string };

// Codex app's own image endpoints (same OAuth). Throws with status on HTTP errors so the caller can fall back.
async function callCodexImagesEndpoint(
	prompt: string,
	imagePaths: string[],
	background: string,
): Promise<{ bytes: Buffer; meta: ImageMeta }> {
	const { token, accountId } = await loadCodexAuth();
	const images = [];
	for (const p of imagePaths) images.push({ image_url: await imageToDataUri(p) });
	const kind = images.length ? "edits" : "generations";
	const body: any = { prompt, background, model: IMAGE_MODEL, quality: "auto", size: "auto" };
	if (images.length) body.images = images.slice(0, 5);
	const postData = JSON.stringify(body);
	return new Promise((resolve, reject) => {
		const req = https.request(
			{
				hostname: "chatgpt.com",
				path: `/backend-api/codex/images/${kind}`,
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"ChatGPT-Account-ID": accountId,
					originator: "codex_cli_rs",
					"User-Agent": `codex_cli_rs/0.161.0 (${process.platform}; ${process.arch}) pi`,
					"Content-Type": "application/json",
				},
				timeout: TIMEOUT_MS,
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (c: Buffer) => chunks.push(c));
				res.on("end", () => {
					const text = Buffer.concat(chunks).toString("utf8");
					if ((res.statusCode || 0) >= 400) {
						const e: any = new Error(`images/${kind} HTTP ${res.statusCode}: ${text.slice(0, 300)}`);
						e.status = res.statusCode;
						return reject(e);
					}
					try {
						const d = JSON.parse(text);
						const b64 = d?.data?.[0]?.b64_json;
						if (!b64) return reject(new Error(`images/${kind}: no image in response`));
						resolve({
							bytes: Buffer.from(b64, "base64"),
							meta: {
								endpoint: `images/${kind}`,
								quality: d.quality,
								size: d.size,
								background: d.background,
								limit: [res.headers["x-codex-active-limit"], res.headers["x-codex-primary-used-percent"]]
									.filter(Boolean)
									.join(" used%="),
							},
						});
					} catch (err) {
						reject(err);
					}
				});
			},
		);
		req.on("timeout", () => req.destroy(new Error("images endpoint timeout")));
		req.on("error", reject);
		req.write(postData);
		req.end();
	});
}

async function callCodexImage(
	prompt: string,
	imagePaths: string[],
	format: string,
	dryRun: boolean,
): Promise<{ bytes?: Buffer; revised?: string; text?: string }> {
	const { token, accountId } = await loadCodexAuth();

	const content: any[] = [{ type: "input_text", text: prompt }];
	for (const p of imagePaths) {
		const dataUri = await imageToDataUri(p);
		content.push({ type: "input_image", image_url: dataUri });
	}

	const body = {
		model: "gpt-6-sol",
		store: false,
		stream: true,
		instructions:
			"Generate image assets. When reference images are attached, keep the subject identical unless the prompt specifies otherwise.",
		input: [{ role: "user", content }],
		tools: [{ type: "image_generation", model: IMAGE_MODEL, output_format: format }],
		tool_choice: { type: "image_generation" },
		parallel_tool_calls: false,
		text: { verbosity: "low" },
	};

	if (dryRun) {
		return { text: JSON.stringify(body, null, 2) };
	}

	const postData = JSON.stringify(body);

	return new Promise((resolve, reject) => {
		const req = https.request(
			{
				hostname: "chatgpt.com",
				path: "/backend-api/codex/responses",
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"chatgpt-account-id": accountId,
					"OpenAI-Beta": "responses=experimental",
					accept: "text/event-stream",
					"content-type": "application/json",
				},
				timeout: TIMEOUT_MS,
			},
			(res) => {
				let buf = "";
				let imageB64: string | null = null;
				let revised: string | null = null;
				let text = "";
				let settled = false;

				const tryParseEvents = () => {
					const events = buf.split("\n\n");
					// 마지막 불완전 청크는 버퍼에 남김
					buf = events.pop() ?? "";
					for (const event of events) {
						const lines = event
							.split("\n")
							.filter((l) => l.startsWith("data:"))
							.map((l) => l.slice(5).trim());
						if (!lines.length) continue;
						const payload = lines.join("\n");
						if (!payload || payload === "[DONE]") continue;
						let e: any;
						try {
							e = JSON.parse(payload);
						} catch {
							continue;
						}
						if (e.type === "response.output_item.done") {
							const item = e.item || {};
							if (item.type === "image_generation_call" && item.result) {
								imageB64 = item.result;
								if (item.revised_prompt) revised = item.revised_prompt;
								// 이미지 도착 즉시 resolve — 나머지 스트림 기다릴 필요 없음
								if (!settled) {
									settled = true;
									resolve({
										bytes: Buffer.from(imageB64, "base64"),
										revised: revised || undefined,
										text: text || undefined,
									});
									req.destroy();
								}
							}
						} else if (e.type === "response.output_text.delta" && e.delta) {
							text += e.delta;
						} else if (e.type === "error" || e.type === "response.failed") {
							if (!settled) {
								settled = true;
								reject(new Error(e.message || JSON.stringify(e)));
							}
						}
					}
				};

				res.on("data", (chunk: Buffer) => {
					buf += chunk.toString();
					tryParseEvents();
				});
				res.on("end", () => {
					if (!settled) {
						settled = true;
						if (imageB64) {
							resolve({
								bytes: Buffer.from(imageB64, "base64"),
								revised: revised || undefined,
								text: text || undefined,
							});
						} else {
							reject(new Error("No image result. Text: " + text.slice(0, 300)));
						}
					}
				});
			},
		);
		req.on("error", (e) => {
			if (!settled) {
				settled = true;
				reject(e);
			}
		});
		req.write(postData);
		req.end();
	});
}

export default function gptImg(pi: ExtensionAPI) {
	pi.registerTool({
		name: "gpt_img",
		label: "GPT Image",
		description:
			"Generate or edit images with gpt-image-2.5-sunburst via ChatGPT/Codex OAuth (no API key). Supports txt2img and img2img via reference images.",
		promptSnippet:
			"Generate or edit images with gpt-image-2.5-sunburst (txt2img + img2img).",
		promptGuidelines: [
			"Use for raster image generation or img2img edits with reference images.",
			"Pass `images` array for img2img; omit for txt2img.",
		],
		parameters: TOOL_PARAMS,
		executionMode: "parallel",
		async execute(toolCallId, params: ToolParams, signal, onUpdate, ctx) {
			const format = params.format || "png";
			const refs = (params.images ?? []).map((p) => abs(p, ctx.cwd));
			const mode = refs.length > 0 ? "edit" : "generate";

			const outPath = params.out
				? abs(params.out, ctx.cwd)
				: join(homedir(), ".pi", "gptimg", `${Date.now()}.${format}`);
			await mkdir(join(outPath, ".."), { recursive: true });

			onUpdate?.({
				content: [{ type: "text", text: `Running ${IMAGE_MODEL} ${mode}...` }],
				details: { mode, format, refs: refs.length, outPath },
			});

			if (params.dryRun) {
				return {
					content: [{ type: "text", text: "[dry-run] prepared." }],
					details: { dryRun: true },
				};
			}

			try {
				const background = params.background || "auto";
				let result: { bytes?: Buffer; meta?: ImageMeta };
				try {
					result = await callCodexImagesEndpoint(params.prompt, refs, background);
				} catch (e: any) {
					// Older accounts/clients without the images endpoint: Responses API tool (no transparency).
					if (e?.status && e.status !== 404 && e.status !== 405) throw e;
					result = { ...(await callCodexImage(params.prompt, refs, format, false)), meta: { endpoint: "responses" } };
				}
				if (!result.bytes) throw new Error("No image bytes");
				await writeFile(outPath, result.bytes);
				// Full-res stays on disk; embed the downscaled version to keep the session lean.
				const embed = (await downscaleForEmbed(result.bytes)) || {
					bytes: result.bytes,
					mimeType: mimeForFormat(format),
				};
				const data = embed.bytes.toString("base64");
				const m = result.meta || { endpoint: "?" };
				const summary = `Generated via ChatGPT Images (${mode}, ${m.endpoint}${m.size ? `, ${m.size}` : ""}${m.quality ? `, quality ${m.quality}` : ""}${m.background ? `, background ${m.background}` : ""}${m.limit ? `, ${m.limit}` : ""}). Saved to ${outPath}.`;
				return {
					content: [
						{ type: "text", text: summary },
						{ type: "image", data, mimeType: embed.mimeType },
					],
					details: { mode, outPath, ...result.meta },
				};
			} catch (err: any) {
				throw new Error(`gpt_img failed: ${err?.message || err}`);
			}
		},
	});
}
