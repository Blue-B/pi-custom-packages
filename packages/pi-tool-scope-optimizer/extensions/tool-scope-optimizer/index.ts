/**
 * tool-scope-optimizer.ts
 *
 * Keep non-xAI sessions lean by trimming the ACTIVE tool set the model sees.
 *
 * CRITICAL API NOTE (verified 2026-06-20):
 *   Tool control lives on the ExtensionAPI object (`pi`), NOT on the hook `ctx`
 *   (ExtensionContext). The earlier version called ctx.getActiveTools /
 *   ctx.setActiveTools, which do not exist on ctx, so the typeof guard made the
 *   whole extension a silent no-op (Cursor shims stayed visible, winshot stayed
 *   callable on coding turns). This version uses pi.getActiveTools() /
 *   pi.setActiveTools() (dist .../extensions/types.d.ts:881-885).
 *
 * WHAT IT HIDES (on non-xai models):
 *   - Cursor/Grok CLI shim aliases (Read/Write/Edit/...) — redundant for Claude
 *   - xAI-native helper tools (xai_*) — unless PI_HIDE_XAI_TOOLS_ON_NON_XAI=0
 *   - Heavy/situational media tools (winshot_*, gpt_img, xai_generate_video) on a
 *     normal coding turn — RESTORED for the turn when the prompt shows media
 *     intent (screenshot/image/video/mask/crop/...). Disable with
 *     PI_LEAN_CODING_TOOLS=0.
 *
 * Tool names may carry an MCP prefix (e.g. "mcp__custom-tools__winshot_capture"),
 * so matching is suffix-aware: a target "winshot_capture" matches both the bare
 * name and any "..__winshot_capture".
 *
 * REVERT: restore tool-scope-optimizer.ts.bak-before-toolscope-* and /reload.
 */
const CURSOR_SHIMS = new Set([
	"Read",
	"Write",
	"StrReplace",
	"Edit",
	"Delete",
	"LS",
	"Grep",
	"Glob",
	"Shell",
	"WebSearch",
]);

const XAI_NATIVE_TOOLS = new Set([
	"xai_generate_text",
	"xai_multi_agent",
	"xai_web_search",
	"xai_x_search",
	"xai_code_execution",
	"xai_generate_image",
	"xai_critique",
	"xai_analyze_image",
	"xai_deep_research",
]);

// Heavy / situational tools that are pure token+choice noise on a normal coding
// turn. Hidden by default on non-xai models, RESTORED for the turn when the
// prompt shows media intent. Set PI_LEAN_CODING_TOOLS=0 to keep them visible.
const HEAVY_TOOLS = new Set([
	"winshot_capture",
	"winshot_crop",
	"winshot_info",
	"winshot_list_monitors",
	"winshot_list_windows",
	"winshot_mask",
	"winshot_resize",
	"gpt_img",
	"xai_generate_video",
]);

function toolNameOf(tool: unknown): string | null {
	if (typeof tool === "string") return tool;
	if (
		tool &&
		typeof tool === "object" &&
		typeof (tool as any).name === "string"
	) {
		return (tool as any).name;
	}
	return null;
}

function isContextModeToolName(name: string): boolean {
	const bare = name.includes("__") ? name.split("__").pop() || name : name;
	return bare.startsWith("ctx_");
}

function mergeUnique(a: string[], b: string[]): string[] {
	const out = a.slice();
	for (const x of b) if (!out.includes(x)) out.push(x);
	return out;
}

// Narrowed 2026-06-24: the prior pattern fired on bare common words (image,
// video, screen, monitor, display, 화면, 이미지, 영상, "show me") that appear in
// ordinary coding talk — every hit flipped the toolset to the full set for 3
// sticky turns and broke that turn's prompt cache. Now unambiguous
// capture/mask/gen keywords match standalone, while ambiguous nouns
// (screen/image/video/화면/이미지/영상) require a capture/generate verb nearby.
// Genuine misses are covered by /tools-full and the sticky window.
const MEDIA_INTENT =
	/(screenshot|screen\s*shot|screen\s*capture|screencap|\bwinshot\b|\bmask(ing)?\b|\bblur\b|\bpixelat|\bmosaic\b|\bcrop\b|generate\s+(an?\s+)?(image|video|picture|photo|icon|wallpaper)|image\s*gen(eration)?|\b(capture|look\s+at|show\s+me)\b[^.?!\n]{0,20}\b(screen|display|window|monitor)\b|스크린\s*샷|스샷|캡처|캡쳐|마스킹|마스크|블러|모자이크|픽셀화|크롭|화면[^.?!\n]{0,8}(보여|캡처|캡쳐|가려|마스)|(이미지|그림|사진|배경화면)[^.?!\n]{0,6}(생성|만들|그려|그린|찍)|(동영상|영상)[^.?!\n]{0,6}(생성|만들|편집))/i;

function hasMediaIntent(prompt?: string): boolean {
	return typeof prompt === "string" && MEDIA_INTENT.test(prompt);
}

/** Suffix-aware match so MCP-prefixed names ("a__b__Read") match target "Read". */
function nameMatches(name: string, set: Set<string>): boolean {
	if (set.has(name)) return true;
	for (const el of set) {
		if (name.endsWith("__" + el)) return true;
	}
	return false;
}

export default function toolScopeOptimizer(pi: any) {
	let fullActiveTools: string[] | null = null;
	let lastSummary = "(not applied yet)";
	// Sticky media window: once media intent is seen, keep heavy tools visible for
	// a few turns so a missed keyword on a follow-up ("now crop it", "그거 잘라줘")
	// does not strand the tool the model already started using. env-tunable.
	const env0 = (globalThis as any).process?.env ?? {};
	const STICKY_TURNS = Math.max(
		0,
		parseInt(env0.PI_MEDIA_STICKY_TURNS || "3", 10) || 0,
	);
	let mediaTurnsLeft = 0;
	// Manual override via /tools-full: forces full set until /tools-lean.
	let forceFull = false;

	function apply(model?: any, prompt?: string) {
		// Tool control is on pi (ExtensionAPI), not ctx (ExtensionContext).
		if (
			typeof pi?.getActiveTools !== "function" ||
			typeof pi?.setActiveTools !== "function"
		) {
			lastSummary = "pi.getActiveTools/setActiveTools unavailable — no-op";
			return;
		}

		const cur = pi.getActiveTools();
		const current: string[] = Array.isArray(cur) ? cur : [];
		const all = typeof pi?.getAllTools === "function" ? pi.getAllTools() : null;
		const contextModeTools: string[] = Array.isArray(all)
			? all
					.map(toolNameOf)
					.filter(
						(name: string | null): name is string =>
							!!name && isContextModeToolName(name),
					)
			: [];
		// Remember the largest set we ever saw as the "full" restore source.
		// context-mode registers ctx_* tools asynchronously via an MCP bridge; if
		// lean mode snapshots tools before that bridge is ready, ctx_* disappears
		// for the whole turn. Always seed fullActiveTools with registered ctx_*.
		const observed = mergeUnique(current, contextModeTools);
		if (
			!fullActiveTools ||
			observed.length > fullActiveTools.length ||
			contextModeTools.some((name) => !fullActiveTools!.includes(name))
		) {
			fullActiveTools = mergeUnique(fullActiveTools ?? [], observed);
		}

		const provider = model?.provider;
		const isXai = provider === "xai-auth";
		const env = (globalThis as any).process?.env ?? {};
		const hideXaiNative = env.PI_HIDE_XAI_TOOLS_ON_NON_XAI !== "0";
		const leanCoding = env.PI_LEAN_CODING_TOOLS !== "0";

		// Decide if heavy/media tools should be visible this turn.
		if (hasMediaIntent(prompt)) mediaTurnsLeft = STICKY_TURNS;
		const mediaActive = forceFull || mediaTurnsLeft > 0;
		if (mediaTurnsLeft > 0) mediaTurnsLeft--; // consume one turn of the sticky window
		const hideHeavy = leanCoding && !isXai && !mediaActive;
		const source = fullActiveTools ?? current;

		const next = isXai
			? source.slice()
			: source.filter(
					(name) =>
						!nameMatches(name, CURSOR_SHIMS) &&
						!(
							hideXaiNative &&
							nameMatches(name, XAI_NATIVE_TOOLS) &&
							!nameMatches(name, new Set(["xai_x_search"]))
						) &&
						!(hideHeavy && nameMatches(name, HEAVY_TOOLS)),
				);

		const changed = next.join("\u0000") !== current.join("\u0000");
		lastSummary =
			`provider=${provider ?? "?"} active=${current.length} -> ${next.length} ` +
			`(full=${source.length}, heavy ${hideHeavy ? "hidden" : "shown"}, ` +
			`media ${mediaActive ? (forceFull ? "forced" : `sticky:${mediaTurnsLeft + 1}`) : "off"}, ` +
			`xaiNative ${hideXaiNative && !isXai ? "hidden" : "shown"})` +
			`${changed ? "" : " [no change]"}`;
		if (changed) pi.setActiveTools(next);
	}

	// Manual escape hatches so a missed keyword never strands a tool.
	pi.registerCommand("tools-full", {
		description:
			"Show ALL tools (un-hide winshot/image/video heavy tools) until /tools-lean.",
		handler: (_args: any, ctx: any) => {
			forceFull = true;
			apply(ctx?.model, undefined);
			ctx?.ui?.notify?.(
				"tool-scope: full tool set forced (heavy tools visible). /tools-lean to revert.",
				"info",
			);
		},
	});
	pi.registerCommand("tools-lean", {
		description:
			"Re-enable lean coding tool set (hide heavy media tools on non-media turns).",
		handler: (_args: any, ctx: any) => {
			forceFull = false;
			mediaTurnsLeft = 0;
			apply(ctx?.model, undefined);
			ctx?.ui?.notify?.("tool-scope: lean mode restored.", "info");
		},
	});

	pi.on("session_start", (_event: any, ctx: any) =>
		apply(ctx?.model, undefined),
	);
	pi.on("model_select", (event: any, ctx: any) =>
		apply(event?.model ?? ctx?.model, undefined),
	);
	pi.on("before_agent_start", (event: any, ctx: any) =>
		apply(ctx?.model, event?.prompt),
	);

	pi.registerTool({
		name: "toolscope_status",
		label: "Tool Scope Status",
		description:
			"Inspect tool-scope-optimizer: live active tool count, what is hidden this turn, and the full restore set.",
		parameters: { type: "object", properties: {} },
		execute: async () => {
			const active =
				typeof pi?.getActiveTools === "function" ? pi.getActiveTools() : null;
			const all =
				typeof pi?.getAllTools === "function" ? pi.getAllTools() : null;
			const lines: string[] = [];
			lines.push(`last apply: ${lastSummary}`);
			lines.push(
				`pi.getActiveTools available: ${typeof pi?.getActiveTools === "function"}`,
			);
			lines.push(
				`pi.setActiveTools available: ${typeof pi?.setActiveTools === "function"}`,
			);
			lines.push(
				`live active tools: ${Array.isArray(active) ? active.length : "n/a"}`,
			);
			lines.push(
				`all configured tools: ${Array.isArray(all) ? all.length : "n/a"}`,
			);
			lines.push(`remembered full set: ${fullActiveTools?.length ?? "n/a"}`);
			if (Array.isArray(active)) {
				const heavyVisible = active.filter((n: string) =>
					nameMatches(n, HEAVY_TOOLS),
				);
				const shimVisible = active.filter((n: string) =>
					nameMatches(n, CURSOR_SHIMS),
				);
				const contextVisible = active.filter((n: string) =>
					isContextModeToolName(n),
				);
				const contextConfigured = Array.isArray(all)
					? all
							.map(toolNameOf)
							.filter(
								(n: string | null): n is string =>
									!!n && isContextModeToolName(n),
							)
					: [];
				const contextMissing = contextConfigured.filter(
					(n: string) => !active.includes(n),
				);
				lines.push(
					`heavy tools currently visible: ${heavyVisible.length ? heavyVisible.join(", ") : "(none — good for coding turn)"}`,
				);
				lines.push(
					`cursor shims currently visible: ${shimVisible.length ? shimVisible.join(", ") : "(none — good)"}`,
				);
				lines.push(
					`context-mode tools visible: ${contextVisible.length ? contextVisible.join(", ") : "(none — broken if configured)"}`,
				);
				lines.push(
					`context-mode tools hidden: ${contextMissing.length ? contextMissing.join(", ") : "(none)"}`,
				);
			}
			return { content: [{ type: "text", text: lines.join("\n") }] };
		},
	});
}
