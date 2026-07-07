/**
 * force-websearch-defaults.ts
 *
 * WHY: In THIS environment (Shell@WSL) web_search only works with a specific config,
 * documented in ~/.pi/agent/AGENTS.md ("Web search — FIXED recipe (stop rediscovering this)"):
 *   - workflow: "none"  -> the default `summary-review` opens an interactive curator that
 *                          goes stale and returns "Search curation cancelled (stale)".
 *   - provider: "exa"   -> `auto` can fall through to dead providers (Perplexity/xAI have no
 *                          key, Gemini host is network-blocked). Only Exa has a valid key.
 *
 * The rule lived in AGENTS.md but is only *probabilistic* guidance — the model kept
 * forgetting it and re-hitting the stale-cancel. This extension makes it DETERMINISTIC.
 *
 * HOW: pi fires the "tool_call" event BEFORE a tool executes and lets a handler mutate
 * `event.input` in place (officially supported — see ToolCallEvent docs in
 * dist/core/extensions/types.d.ts). We ONLY touch web_search calls, and ONLY fill in
 * fields that are absent or set to the broken `auto`/curator default — so any explicit
 * choice is preserved, and every other tool is a pure pass-through (zero side effects).
 *
 * REVERT: delete this file and run `/reload` in pi (or just start a new session).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// web_search may surface natively ("web_search") or via the meridian/oc gateway
// ("mcp__oc__web_search"). Match both, plus any "<ns>.web_search" variant.
function isWebSearch(name: unknown): name is string {
  return (
    typeof name === "string" &&
    (name === "web_search" ||
      name.endsWith("__web_search") ||
      name.endsWith(".web_search"))
  );
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", (event) => {
    // Only act on web_search; everything else passes through untouched.
    if (!isWebSearch((event as { toolName?: unknown }).toolName)) return;

    const input = (event as { input?: unknown }).input;
    if (!input || typeof input !== "object") return;
    const args = input as Record<string, unknown>;

    // Fill the curator-default workflow only when the model didn't choose one.
    if (args.workflow === undefined || args.workflow === null) {
      args.workflow = "none";
    }

    // Force the only working provider when missing or left on the broken `auto`.
    if (
      args.provider === undefined ||
      args.provider === null ||
      args.provider === "auto"
    ) {
      args.provider = "exa";
    }

    // Mutated in place — nothing to return. (block?/reason? left unset = allow.)
  });
}
