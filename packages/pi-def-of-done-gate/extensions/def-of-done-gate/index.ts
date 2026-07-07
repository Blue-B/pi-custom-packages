/**
 * def-of-done-gate.ts
 *
 * WHY: The model tends to edit code and then report "done" without running any
 *      verification, only fixing things after the user points them out. Keeping
 *      the "verify before done" rule as prose in AGENTS.md is weak: under context
 *      pressure the model nods at it and skips it. This turns the rule into a
 *      runtime signal instead of exhortation.
 *
 * WHAT IT DOES (per agent loop): tracks code-mutation tools vs verification
 *  signals (lsp/lens diagnostics, a test|build|lint bash, a reviewer subagent).
 *  At agent_end, if code was mutated but nothing verified it, warns and arms a
 *  reminder that is injected at the next before_agent_start. It never rewrites
 *  the assistant message, and stays dormant if tool_call doesn't fire.
 *
 * CONTROL: DOD_GATE_DISABLE=1 -> inert. /def-of-done-status -> inspect state.
 */

const ENV: Record<string, string | undefined> =
	(globalThis as any).process?.env || {};
const DISABLED = ENV.DOD_GATE_DISABLE === "1";

// Tool leaf names (after stripping any "mcp__namespace__" or "ns:" prefix).
const MUTATION_TOOLS = new Set([
	"edit",
	"write",
	"multiedit",
	"ast_grep_replace",
]);
const VERIFY_TOOLS = new Set(["lsp_diagnostics", "lens_diagnostics"]);

// bash commands that count as real verification of changed code.
const VERIFY_BASH =
	/\b(tsc|tsgo|eslint|biome|ruff|mypy|pyright|pytest|vitest|jest|cargo\s+(check|test|build|clippy)|go\s+(test|build|vet)|npm\s+(run\s+)?(test|check|build|lint|typecheck)|pnpm\s+(run\s+)?(test|check|build|lint|typecheck)|yarn\s+(test|check|build|lint|typecheck)|bash\s+-n|node\s+--check|make(\s|$)|gradle|mvn\s+(test|verify)|dotnet\s+(test|build))\b/i;

// "code" file extensions (config/docs intentionally excluded). Rare extensions
// rely on the unknown-path fallback instead of being listed here.
const CODE_EXT = new Set(
	"ts tsx js jsx mjs cjs py rs go java kt c cc cpp h hpp cs rb php swift scala sh lua vue svelte sql".split(
		" ",
	),
);

type Ledger = { mutations: number; files: Set<string>; verified: boolean };
const freshLedger = (): Ledger => ({
	mutations: 0,
	files: new Set(),
	verified: false,
});

let ledger: Ledger = freshLedger();
let pendingGate: { files: string[]; mutations: number } | null = null;
let lastEval = "(no evaluation yet)";

function leaf(name: unknown): string {
	if (typeof name !== "string" || !name) return "";
	let s = name;
	const u = s.lastIndexOf("__");
	if (u >= 0) s = s.slice(u + 2);
	const c = s.lastIndexOf(":");
	if (c >= 0) s = s.slice(c + 1);
	return s.toLowerCase();
}

function filesOf(input: any): string[] {
	const out = [input?.path, input?.file_path, input?.filePath].filter(
		(v): v is string => typeof v === "string" && !!v,
	);
	if (Array.isArray(input?.paths))
		for (const p of input.paths) if (typeof p === "string" && p) out.push(p);
	return out;
}

function isCodeFile(p: string): boolean {
	const base = p.split(/[\\/]/).pop() ?? p;
	const dot = base.lastIndexOf(".");
	if (dot <= 0) return false; // no ext, or dotfile like .bashrc -> not "code"
	return CODE_EXT.has(base.slice(dot + 1).toLowerCase());
}

function isVerify(name: string, input: any): boolean {
	if (VERIFY_TOOLS.has(name)) return true;
	if (name === "bash") return VERIFY_BASH.test(String(input?.command ?? ""));
	if (name === "subagent")
		return JSON.stringify(input ?? {})
			.toLowerCase()
			.includes("review");
	return false;
}

export default function defOfDoneGate(pi: any) {
	if (DISABLED) {
		pi.registerCommand?.("def-of-done-status", {
			description: "def-of-done gate (DISABLED via DOD_GATE_DISABLE=1)",
			handler: (_a: any, ctx: any) =>
				ctx?.ui?.notify?.("def-of-done-gate: DISABLED", "info"),
		});
		return;
	}

	pi.on("session_start", () => {
		ledger = freshLedger();
		pendingGate = null;
	});

	pi.on("tool_call", (event: any) => {
		const name = leaf(event?.toolName);
		if (!name) return;
		if (MUTATION_TOOLS.has(name)) {
			ledger.mutations++;
			for (const f of filesOf(event?.input)) ledger.files.add(f);
		} else if (isVerify(name, event?.input)) {
			ledger.verified = true;
		}
	});

	pi.on("agent_end", (_event: any, ctx: any) => {
		const { mutations, verified } = ledger;
		const paths = [...ledger.files];
		const codePaths = paths.filter(isCodeFile);
		const relevant =
			codePaths.length > 0 || (mutations > 0 && paths.length === 0);

		if (mutations > 0 && !verified && relevant) {
			pendingGate = {
				files: (codePaths.length ? codePaths : paths).slice(0, 6),
				mutations,
			};
			lastEval = `MISS: ${mutations} edits / 0 verification`;
			try {
				ctx?.ui?.notify?.(
					`def-of-done ⚠ ${mutations} code edit(s) this turn with zero verification. Run lsp_diagnostics or a test/build before reporting done.`,
					"warning",
				);
			} catch (e) {
				void e; // UI notify is best-effort; never let it break the turn
			}
		} else {
			lastEval =
				mutations === 0
					? "OK: no code edits"
					: `OK: ${mutations} edits / verification ${verified ? "present" : "config/doc only"}`;
		}
	});

	pi.on("before_agent_start", (_event: any) => {
		const gate = pendingGate;
		pendingGate = null;
		ledger = freshLedger();
		if (!gate) return undefined;

		const fileList = gate.files.length
			? gate.files.map((f) => `  - ${f}`).join("\n")
			: "  (no edited file paths were recorded)";
		const content =
			`[def-of-done gate] The previous turn made ${gate.mutations} code edit(s) but ` +
			`no verification tool (lsp_diagnostics / lens_diagnostics / test|build|lint bash / reviewer) was run.\n` +
			`Edited:\n${fileList}\n` +
			`Before reporting "done" this turn, actually verify the changed files (at minimum lsp_diagnostics, ` +
			`ideally the relevant build/test) and base your report on the result. If verification is not possible, say so explicitly. ` +
			`(Auto-injected by def-of-done-gate. Disable with DOD_GATE_DISABLE=1)`;

		return {
			message: { customType: "def-of-done-gate", content, display: false },
		};
	});

	pi.registerCommand?.("def-of-done-status", {
		description:
			"def-of-done gate: show the current ledger, last evaluation, and pending flag",
		handler: (_args: any, ctx: any) => {
			const pend = pendingGate
				? `pending (${pendingGate.mutations} edits, ${pendingGate.files.join(", ") || "-"})`
				: "none";
			ctx?.ui?.notify?.(
				`def-of-done | turn edits=${ledger.mutations} verified=${ledger.verified ? "Y" : "N"} | last=${lastEval} | next-turn injection=${pend}`,
				"info",
			);
		},
	});
}
