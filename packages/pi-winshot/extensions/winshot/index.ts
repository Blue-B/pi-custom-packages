/**
 * pi-winshot extension
 *
 * Lets the AI capture and edit the Windows host screen from inside WSL.
 *
 * Tools registered:
 *   - winshot_list_windows        list visible top-level Windows windows
 *   - winshot_list_monitors       list connected monitors
 *   - winshot_capture             capture full / region / monitor / active / window (PrintWindow)
 *   - winshot_crop                crop an existing PNG by pixel rect
 *   - winshot_mask                mask one or more regions (black / blur / pixelate)
 *   - winshot_resize              resize keeping aspect ratio
 *   - winshot_info                report PNG dimensions
 *
 * Commands:
 *   /winshot full          capture full screen and attach
 *   /winshot active        capture active window
 *   /winshot window <q>    capture window whose title contains <q>
 *   /winshot list          list windows
 *
 * Zero external dependencies: just powershell.exe + .NET System.Drawing.
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdir, readFile, stat } from "node:fs/promises";
import { existsSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// --- locate bundled PowerShell scripts ---------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT_DIR_CANDIDATES = [
	// installed via npm: extensions/winshot/index.ts next to scripts/
	resolve(HERE, "..", "..", "scripts"),
	// local dev layout
	resolve(HERE, "..", "scripts"),
	resolve(HERE, "scripts"),
];

function findScript(name: string): string {
	for (const d of SCRIPT_DIR_CANDIDATES) {
		const p = join(d, name);
		if (existsSync(p)) return p;
	}
	throw new Error(
		`pi-winshot: cannot find ${name}; tried ${SCRIPT_DIR_CANDIDATES.join(", ")}`,
	);
}

// --- WSL <-> Windows path helpers --------------------------------------------

const IS_WSL = (() => {
	try {
		if (process.platform !== "linux") return false;
		const v = require("node:fs").readFileSync("/proc/version", "utf8");
		return /microsoft/i.test(v);
	} catch {
		return false;
	}
})();

function wslToWin(p: string): string {
	// /mnt/c/foo/bar  -> C:\foo\bar
	const m = p.match(/^\/mnt\/([a-z])\/(.*)$/i);
	if (m) return `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, "\\")}`;
	// WSL-native path (/home/..., /tmp/..., etc.) -> \\wsl.localhost\<distro>\...
	// powershell.exe + .NET System.Drawing can read/write and execute over these UNC paths.
	if (p.startsWith("/")) {
		try {
			const win = execFileSync("wslpath", ["-w", p], {
				encoding: "utf8",
			}).trim();
			if (win) return win;
		} catch {
			/* wslpath unavailable; fall through to raw path */
		}
	}
	return p; // assume already a Windows path or unconvertible
}

function winToWsl(p: string): string {
	// C:\foo\bar -> /mnt/c/foo/bar
	const m = p.match(/^([a-zA-Z]):\\(.*)$/);
	if (m) return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}`;
	return p;
}

// --- output directory ---------------------------------------------------------

function defaultOutDir(): string {
	// Put captures somewhere both WSL and Windows can read.
	return "/mnt/c/tmp/pi-winshot";
}

async function ensureOutDir(linuxDir: string): Promise<void> {
	await mkdir(linuxDir, { recursive: true });
}

function uniqName(prefix: string): string {
	const stamp = new Date()
		.toISOString()
		.replace(/[-:T.Z]/g, "")
		.slice(0, 14);
	const rand = Math.random().toString(36).slice(2, 6);
	return `${prefix}_${stamp}_${rand}.png`;
}

// --- powershell invoker -------------------------------------------------------

interface PSResult {
	stdout: string;
	stderr: string;
	code: number;
}

function runPS(
	scriptWinPath: string,
	args: string[],
	signal?: AbortSignal,
): Promise<PSResult> {
	return new Promise((resolveP, rejectP) => {
		const cmd = "powershell.exe";
		const cmdArgs = [
			"-NoProfile",
			"-ExecutionPolicy",
			"Bypass",
			"-Command",
			`[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; & '${scriptWinPath}' ${args.join(" ")}`,
		];
		const ps = spawn(cmd, cmdArgs, { signal });
		let stdout = "";
		let stderr = "";
		ps.stdout.on("data", (b) => {
			stdout += b.toString("utf8");
		});
		ps.stderr.on("data", (b) => {
			stderr += b.toString("utf8");
		});
		ps.on("error", rejectP);
		ps.on("close", (code) => resolveP({ stdout, stderr, code: code ?? -1 }));
	});
}

function shellQuote(v: string): string {
	// PowerShell single-quoted strings escape ' as ''
	return `'${v.replace(/'/g, "''")}'`;
}

function parseJsonLine(stdout: string): any {
	const lines = stdout
		.split(/\r?\n/)
		.map((s) => s.trim())
		.filter(Boolean);
	for (let i = lines.length - 1; i >= 0; i--) {
		const t = lines[i];
		if (t.startsWith("{") || t.startsWith("[")) {
			try {
				return JSON.parse(t);
			} catch {
				/* try next */
			}
		}
	}
	throw new Error(`could not parse JSON output: ${stdout.slice(0, 500)}`);
}

// --- image -> tool content ----------------------------------------------------

// Codex/Claude-Code-style image handling: downscale every image to a bounded
// resolution BEFORE embedding its base64 into the tool result. pi (and the
// claude-bridge -> claude CLI chain) has no image-aware context management, so a
// full-res PNG screenshot (multi-MB base64) accumulates in context and is the #1
// cause of the "infinite compaction" loop. Anthropic auto-downscales images to
// <=1568px long edge before tokenizing anyway ((w*h)/750 tokens), so capping the
// long edge here costs the model nothing in legibility while shrinking the wire
// payload ~15x (e.g. 2.36MB PNG -> 150KB JPEG, 2176x1227 -> 1568x884). The
// full-resolution PNG stays on disk; the tool still returns its path for
// on-demand re-reading. Override with WINSHOT_EMBED_MAX_EDGE; disable with
// WINSHOT_NO_DOWNSCALE=1.
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
const EMBED_MAX_EDGE = Number(process.env.WINSHOT_EMBED_MAX_EDGE) || 1568;
const EMBED_DOWNSCALE =
	process.env.WINSHOT_NO_DOWNSCALE !== "1" && FFMPEG !== null;

async function readImageContent(
	linuxPath: string,
): Promise<{ type: "image"; data: string; mimeType: string }> {
	if (EMBED_DOWNSCALE) {
		const out = join(
			tmpdir(),
			`winshot_embed_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jpg`,
		);
		try {
			execFileSync(
				FFMPEG!,
				[
					"-y",
					"-loglevel",
					"error",
					"-i",
					linuxPath,
					// Fit inside an EMBED_MAX_EDGE square, preserving aspect ratio, never upscaling.
					"-vf",
					`scale=w=min(${EMBED_MAX_EDGE}\\,iw):h=min(${EMBED_MAX_EDGE}\\,ih):force_original_aspect_ratio=decrease`,
					"-q:v",
					"5",
					out,
				],
				{ stdio: ["ignore", "ignore", "pipe"] },
			);
			const buf = await readFile(out);
			return {
				type: "image",
				data: buf.toString("base64"),
				mimeType: "image/jpeg",
			};
		} catch {
			// Never brick a capture: fall back to the original on any ffmpeg failure.
		} finally {
			try {
				unlinkSync(out);
			} catch {
				/* ignore */
			}
		}
	}
	const buf = await readFile(linuxPath);
	return { type: "image", data: buf.toString("base64"), mimeType: "image/png" };
}

// =============================================================================
// extension
// =============================================================================

export default function winshot(pi: ExtensionAPI): void {
	if (!IS_WSL) {
		// Soft guard: still register so the user sees friendly errors if they try.
		pi.on("session_start", (_e, ctx) => {
			if (ctx.hasUI) {
				ctx.ui.notify(
					"pi-winshot is intended for WSL. powershell.exe must be reachable.",
					"warning",
				);
			}
		});
	}

	const capturePs = findScript("capture.ps1");
	const editPs = findScript("edit.ps1");
	const listPs = findScript("list.ps1");

	// ----- list_windows --------------------------------------------------------

	pi.registerTool({
		name: "winshot_list_windows",
		label: "List Windows windows",
		description:
			"List visible top-level windows on the Windows host (handle, title, position, size, minimized flag). " +
			"Use this to find a window's title substring before calling winshot_capture with mode='window'.",
		parameters: Type.Object({}),
		executionMode: "parallel",
		execute: async (_id, _params, signal) => {
			const r = await runPS(
				wslToWin(listPs),
				["-What", "windows", "-Json"],
				signal,
			);
			if (r.code !== 0)
				throw new Error(`list windows failed: ${r.stderr || r.stdout}`);
			const data = parseJsonLine(r.stdout);
			const text = (Array.isArray(data) ? data : [data])
				.map(
					(w: any) =>
						`${w.handle} ${w.minimized ? "[min]" : "     "} ${String(w.w).padStart(5)}x${String(w.h).padEnd(5)}  ${w.title}`,
				)
				.join("\n");
			return {
				content: [{ type: "text", text: text || "(no windows)" }],
				details: { windows: data },
			};
		},
	});

	// ----- list_monitors -------------------------------------------------------

	pi.registerTool({
		name: "winshot_list_monitors",
		label: "List monitors",
		description:
			"List connected monitors with their virtual-desktop coordinates and primary flag.",
		parameters: Type.Object({}),
		executionMode: "parallel",
		execute: async (_id, _params, signal) => {
			const r = await runPS(
				wslToWin(listPs),
				["-What", "monitors", "-Json"],
				signal,
			);
			if (r.code !== 0)
				throw new Error(`list monitors failed: ${r.stderr || r.stdout}`);
			const data = parseJsonLine(r.stdout);
			const arr = Array.isArray(data) ? data : [data];
			const text = arr
				.map(
					(m: any) =>
						`monitor[${m.index}] primary=${m.primary} x=${m.x} y=${m.y} w=${m.w} h=${m.h}`,
				)
				.join("\n");
			return {
				content: [{ type: "text", text: text || "(no monitors)" }],
				details: { monitors: arr },
			};
		},
	});

	// ----- capture -------------------------------------------------------------

	pi.registerTool({
		name: "winshot_capture",
		label: "Capture Windows screen",
		description:
			"Capture the Windows host screen and return the PNG to the model. " +
			"Modes:\n" +
			" - full     : whole virtual desktop across all monitors\n" +
			" - region   : screen-coordinate rectangle (-x -y -w -h required)\n" +
			" - monitor  : a single monitor by index (use winshot_list_monitors first)\n" +
			" - active   : current foreground window (uses PrintWindow, occlusion-safe)\n" +
			" - window   : window whose title contains the given substring; works even when the window is occluded.\n" +
			"Pass bring_to_front=true to restore/foreground a minimized window before capture.\n" +
			"Output PNG is saved under /mnt/c/tmp/pi-winshot/ unless `out` is given.",
		parameters: Type.Object({
			mode: Type.Union([
				Type.Literal("full"),
				Type.Literal("region"),
				Type.Literal("monitor"),
				Type.Literal("active"),
				Type.Literal("window"),
			]),
			x: Type.Optional(Type.Integer()),
			y: Type.Optional(Type.Integer()),
			w: Type.Optional(Type.Integer()),
			h: Type.Optional(Type.Integer()),
			monitor: Type.Optional(Type.Integer({ minimum: 0 })),
			title: Type.Optional(
				Type.String({
					description: "case-insensitive substring of the window title",
				}),
			),
			bring_to_front: Type.Optional(Type.Boolean({ default: false })),
			out: Type.Optional(
				Type.String({
					description:
						"output path; accepts WSL (/mnt/c/...) or Windows (C:\\...) path",
				}),
			),
			return_image: Type.Optional(
				Type.Boolean({
					default: true,
					description:
						"embed the PNG in the tool result so the model can see it",
				}),
			),
		}),
		executionMode: "sequential",
		execute: async (_id, params, signal) => {
			const outDir = defaultOutDir();
			await ensureOutDir(outDir);
			const outLinux = params.out
				? params.out.startsWith("/")
					? params.out
					: winToWsl(params.out)
				: join(outDir, uniqName(`cap_${params.mode}`));
			const outWin = wslToWin(outLinux);

			const args: string[] = [
				"-Mode",
				params.mode,
				"-Out",
				shellQuote(outWin),
				"-Json",
			];
			if (params.mode === "region") {
				if (
					params.x == null ||
					params.y == null ||
					params.w == null ||
					params.h == null
				) {
					throw new Error("region mode requires x, y, w, h");
				}
				args.push(
					"-X",
					String(params.x),
					"-Y",
					String(params.y),
					"-W",
					String(params.w),
					"-H",
					String(params.h),
				);
			}
			if (params.mode === "monitor") {
				if (params.monitor == null)
					throw new Error("monitor mode requires monitor index");
				args.push("-Monitor", String(params.monitor));
			}
			if (params.mode === "window") {
				if (!params.title) throw new Error("window mode requires title");
				args.push("-Title", shellQuote(params.title));
			}
			if (params.bring_to_front) args.push("-BringToFront");

			const r = await runPS(wslToWin(capturePs), args, signal);
			if (r.code !== 0)
				throw new Error(`capture failed: ${r.stderr || r.stdout}`);
			const meta = parseJsonLine(r.stdout);

			const summary =
				`Captured ${meta.mode} via ${meta.method} ${meta.w}x${meta.h} at (${meta.x},${meta.y})` +
				(meta.title ? `\nwindow: ${meta.title}` : "") +
				`\nsaved: ${outLinux}`;

			const content: any[] = [{ type: "text", text: summary }];
			if (params.return_image !== false) {
				content.push(await readImageContent(outLinux));
			}
			return { content, details: { ...meta, out_linux: outLinux } };
		},
	});

	// ----- crop ----------------------------------------------------------------

	pi.registerTool({
		name: "winshot_crop",
		label: "Crop screenshot",
		description:
			"Crop a previously-captured PNG by pixel rectangle in image coordinates. " +
			"Use this to trim over-captured screenshots down to the exact region you want.",
		parameters: Type.Object({
			in: Type.String({ description: "input PNG path (WSL or Windows)" }),
			x: Type.Integer(),
			y: Type.Integer(),
			w: Type.Integer(),
			h: Type.Integer(),
			out: Type.Optional(Type.String()),
			return_image: Type.Optional(Type.Boolean({ default: true })),
		}),
		executionMode: "sequential",
		execute: async (_id, params, signal) => {
			const inLinux = params.in.startsWith("/")
				? params.in
				: winToWsl(params.in);
			if (!existsSync(inLinux)) throw new Error(`input not found: ${inLinux}`);
			const outLinux = params.out
				? params.out.startsWith("/")
					? params.out
					: winToWsl(params.out)
				: inLinux.replace(/\.png$/i, "_crop.png");
			const args = [
				"-Op",
				"crop",
				"-In",
				shellQuote(wslToWin(inLinux)),
				"-Out",
				shellQuote(wslToWin(outLinux)),
				"-X",
				String(params.x),
				"-Y",
				String(params.y),
				"-W",
				String(params.w),
				"-H",
				String(params.h),
				"-Json",
			];
			const r = await runPS(wslToWin(editPs), args, signal);
			if (r.code !== 0) throw new Error(`crop failed: ${r.stderr || r.stdout}`);
			const meta = parseJsonLine(r.stdout);
			const content: any[] = [
				{
					type: "text",
					text: `Cropped to ${meta.w}x${meta.h} at (${meta.x},${meta.y})\nsaved: ${outLinux}`,
				},
			];
			if (params.return_image !== false)
				content.push(await readImageContent(outLinux));
			return { content, details: { ...meta, out_linux: outLinux } };
		},
	});

	// ----- mask ----------------------------------------------------------------

	pi.registerTool({
		name: "winshot_mask",
		label: "Mask regions",
		description:
			"Mask one or more rectangular regions of a PNG to hide private info (API keys, names, tokens, faces). " +
			"Styles:\n" +
			" - black   : solid black rectangle (default, most opaque)\n" +
			" - pixelate: mosaic blocks (recognizable shape but unreadable text)\n" +
			" - blur    : downscale-upscale soft blur",
		parameters: Type.Object({
			in: Type.String(),
			regions: Type.Array(
				Type.Object({
					x: Type.Integer(),
					y: Type.Integer(),
					w: Type.Integer(),
					h: Type.Integer(),
				}),
				{ minItems: 1, description: "rectangles in image pixel coordinates" },
			),
			style: Type.Optional(
				Type.Union(
					[
						Type.Literal("black"),
						Type.Literal("blur"),
						Type.Literal("pixelate"),
					],
					{ default: "black" } as any,
				),
			),
			pixel: Type.Optional(
				Type.Integer({
					minimum: 2,
					description: "pixelate block size",
					default: 16,
				} as any),
			),
			blur_radius: Type.Optional(
				Type.Integer({ minimum: 2, default: 12 } as any),
			),
			out: Type.Optional(Type.String()),
			return_image: Type.Optional(Type.Boolean({ default: true })),
		}),
		executionMode: "sequential",
		execute: async (_id, params, signal) => {
			const inLinux = params.in.startsWith("/")
				? params.in
				: winToWsl(params.in);
			if (!existsSync(inLinux)) throw new Error(`input not found: ${inLinux}`);
			const outLinux = params.out
				? params.out.startsWith("/")
					? params.out
					: winToWsl(params.out)
				: inLinux.replace(/\.png$/i, "_masked.png");
			const regionSpec = params.regions
				.map((r: any) => `${r.x},${r.y},${r.w},${r.h}`)
				.join(";");
			const style = (params as any).style ?? "black";
			const args = [
				"-Op",
				"mask",
				"-In",
				shellQuote(wslToWin(inLinux)),
				"-Out",
				shellQuote(wslToWin(outLinux)),
				"-Regions",
				shellQuote(regionSpec),
				"-MaskStyle",
				style,
				"-Json",
			];
			if ((params as any).pixel != null)
				args.push("-Pixel", String((params as any).pixel));
			if ((params as any).blur_radius != null)
				args.push("-BlurRadius", String((params as any).blur_radius));
			const r = await runPS(wslToWin(editPs), args, signal);
			if (r.code !== 0) throw new Error(`mask failed: ${r.stderr || r.stdout}`);
			const meta = parseJsonLine(r.stdout);
			const content: any[] = [
				{
					type: "text",
					text: `Masked ${meta.count} region(s) with style=${meta.style}\nsaved: ${outLinux}`,
				},
			];
			if (params.return_image !== false)
				content.push(await readImageContent(outLinux));
			return { content, details: { ...meta, out_linux: outLinux } };
		},
	});

	// ----- resize --------------------------------------------------------------

	pi.registerTool({
		name: "winshot_resize",
		label: "Resize screenshot",
		description:
			"Resize a PNG keeping aspect ratio. Use this to reduce token cost before showing a large screenshot to the model. " +
			"Provide one of: scale (e.g. 0.5), max_w, or max_h.",
		parameters: Type.Object({
			in: Type.String(),
			scale: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
			max_w: Type.Optional(Type.Integer({ minimum: 1 })),
			max_h: Type.Optional(Type.Integer({ minimum: 1 })),
			out: Type.Optional(Type.String()),
			return_image: Type.Optional(Type.Boolean({ default: true })),
		}),
		executionMode: "sequential",
		execute: async (_id, params, signal) => {
			const inLinux = params.in.startsWith("/")
				? params.in
				: winToWsl(params.in);
			if (!existsSync(inLinux)) throw new Error(`input not found: ${inLinux}`);
			const outLinux = params.out
				? params.out.startsWith("/")
					? params.out
					: winToWsl(params.out)
				: inLinux.replace(/\.png$/i, "_resized.png");
			const args = [
				"-Op",
				"resize",
				"-In",
				shellQuote(wslToWin(inLinux)),
				"-Out",
				shellQuote(wslToWin(outLinux)),
				"-Json",
			];
			if (params.scale != null) args.push("-Scale", String(params.scale));
			if (params.max_w != null) args.push("-MaxW", String(params.max_w));
			if (params.max_h != null) args.push("-MaxH", String(params.max_h));
			const r = await runPS(wslToWin(editPs), args, signal);
			if (r.code !== 0)
				throw new Error(`resize failed: ${r.stderr || r.stdout}`);
			const meta = parseJsonLine(r.stdout);
			const content: any[] = [
				{
					type: "text",
					text: `Resized ${meta.from_w}x${meta.from_h} -> ${meta.w}x${meta.h}\nsaved: ${outLinux}`,
				},
			];
			if (params.return_image !== false)
				content.push(await readImageContent(outLinux));
			return { content, details: { ...meta, out_linux: outLinux } };
		},
	});

	// ----- info ----------------------------------------------------------------

	pi.registerTool({
		name: "winshot_info",
		label: "Image dimensions",
		description:
			"Report the width/height of a PNG. Use this before crop/mask to ground your coordinate math.",
		parameters: Type.Object({ in: Type.String() }),
		executionMode: "parallel",
		execute: async (_id, params, signal) => {
			const inLinux = params.in.startsWith("/")
				? params.in
				: winToWsl(params.in);
			if (!existsSync(inLinux)) throw new Error(`input not found: ${inLinux}`);
			const args = [
				"-Op",
				"info",
				"-In",
				shellQuote(wslToWin(inLinux)),
				"-Json",
			];
			const r = await runPS(wslToWin(editPs), args, signal);
			if (r.code !== 0) throw new Error(`info failed: ${r.stderr || r.stdout}`);
			const meta = parseJsonLine(r.stdout);
			return {
				content: [{ type: "text", text: `${meta.w}x${meta.h} ${inLinux}` }],
				details: { ...meta, in_linux: inLinux },
			};
		},
	});

	// ----- slash command -------------------------------------------------------

	pi.registerCommand("winshot", {
		description:
			"Capture the Windows screen. Usage: /winshot [full|active|list|window <q>]",
		handler: async (args, _ctx) => {
			const a = (args ?? "").trim();
			const parts = a.split(/\s+/).filter(Boolean);
			const sub = parts[0] || "full";
			if (sub === "list") {
				await pi.sendMessage({
					customType: "user-text" as any,
					content: "Use winshot_list_windows tool and show me the result.",
					display: false,
				});
				return;
			}
			if (sub === "window") {
				const q = parts.slice(1).join(" ");
				if (!q) throw new Error("Usage: /winshot window <title-substring>");
				await pi.sendMessage(
					{
						customType: "user-text" as any,
						content: `Use winshot_capture with mode="window" and title=${JSON.stringify(q)} and show the result.`,
						display: false,
					},
					{ triggerTurn: true },
				);
				return;
			}
			if (sub === "active") {
				await pi.sendMessage(
					{
						customType: "user-text" as any,
						content: `Use winshot_capture with mode="active" and show the result.`,
						display: false,
					},
					{ triggerTurn: true },
				);
				return;
			}
			// default: full
			await pi.sendMessage(
				{
					customType: "user-text" as any,
					content: `Use winshot_capture with mode="full" and show the result.`,
					display: false,
				},
				{ triggerTurn: true },
			);
		},
	});
}
