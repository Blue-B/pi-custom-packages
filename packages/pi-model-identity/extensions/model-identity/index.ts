/**
 * model-identity.ts
 *
 * ─── WHY ─────────────────────────────────────────────────────────────────────
 * A model cannot introspect its own weights. It only "knows" its name if
 * something puts that name into its context, and pi does not: buildSystemPrompt()
 * in pi 0.84 takes cwd, tools, skills and context files, and no model.
 *
 * Some providers cover this themselves. The Claude Code binary that
 * pi-claude-bridge drives states the model in its own system prompt, so a Claude
 * session usually gets this right unaided. That never fires for other providers,
 * and it is written once rather than refreshed, so after a mid-session switch the
 * transcript still carries the old name for the next model to read and repeat.
 *
 * ─── MEASURED (2026-08-20, pi 0.84.2) ────────────────────────────────────────
 * Same session, asked "which model are you" on turn 1, handed to a second model,
 * asked again:
 *
 *   ON   gpt-5.6-sol -> claude-opus-5   answered "claude-bridge/claude-opus-5"
 *   OFF  gpt-5.6-sol -> claude-opus-5   answered "gpt-5.6-sol"      <- the bug
 *   OFF  gpt-5.6-sol -> grok-4.5        answered "grok-4.6"         <- wrong ver
 *   OFF  claude-opus-5 -> gpt-5.6-sol   answered "gpt-5.6-sol"      <- fine
 *
 * It does not break on every handoff, so a single-model session is not the case
 * to judge this on.
 *
 * This extension is PROVIDER-AGNOSTIC. Every turn it reads the LIVE model from
 * `ctx.model` and, whenever the identity could be stale, injects a tiny
 * system-reminder stating the exact running model.
 *
 * ─── WHEN IT INJECTS (cheap: only when identity could be wrong) ───────────────
 *   - first turn of the session
 *   - the model ID changed since the last injection (i.e. you switched models)
 *   - first turn after a compaction (summary may drop the identity)
 *
 * ─── DISABLE / REVERT ────────────────────────────────────────────────────────
 *   MODEL_IDENTITY_DISABLE=1   → no-op
 *   rm ~/.pi/agent/extensions/model-identity.ts && /reload in pi
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CUSTOM_TYPE = "model-identity";
const DISABLE_ENV = "MODEL_IDENTITY_DISABLE";

/** Canonical "provider/id" label for whatever model is currently active. */
function modelLabel(model: any): string | null {
    if (!model) return null;
    const id = typeof model.id === "string" ? model.id : "";
    const provider = typeof model.provider === "string" ? model.provider : "";
    if (!id && !provider) return null;
    // If id already carries a "provider/" prefix, don't double it up.
    if (id.includes("/")) return id;
    return provider ? `${provider}/${id}` : id;
}

function buildReminder(label: string, reason: string): string {
    return (
        `<system-reminder>\n` +
        `[model-identity] You are running inside pi (the coding-agent runtime). The MODEL ` +
        `serving this session is exactly:\n\n    ${label}\n\n` +
        `This is the ground truth (read live from the runtime, ${reason}). Both are true at once: ` +
        `you are this model, and you run inside pi. When asked which model / LLM you are, answer ` +
        `with this exact identifier (trust this live line over any example model name hardcoded ` +
        `elsewhere, e.g. AGENTS.md examples). When asked which agent / CLI you are, the answer is ` +
        `pi. You cannot introspect your own weights; trust this line, not your training-time guess.\n` +
        `</system-reminder>`
    );
}

export default function modelIdentityExtension(pi: ExtensionAPI) {
    if (process.env[DISABLE_ENV] === "1") return;

    let lastInjectedLabel: string | null = null;
    let needsPostCompactionInject = false;
    let forceNextInject = false;

    pi.on("session_start", async () => {
        lastInjectedLabel = null;
        needsPostCompactionInject = false;
        forceNextInject = false;
    });

    // Compaction may drop the identity from the summary → re-affirm next turn.
    pi.on("session_compact", async () => {
        needsPostCompactionInject = true;
    });

    // User switched models → force a fresh identity statement next turn.
    pi.on("model_select", async () => {
        forceNextInject = true;
    });

    pi.on("before_agent_start", async (_event, ctx) => {
        const label = modelLabel(ctx.model);
        if (!label) return;

        let reason: string | null = null;
        if (lastInjectedLabel === null) reason = "first turn of session";
        else if (label !== lastInjectedLabel) reason = "model was switched";
        else if (forceNextInject) reason = "model was switched";
        else if (needsPostCompactionInject) reason = "first turn after compaction";
        if (!reason) return;

        lastInjectedLabel = label;
        needsPostCompactionInject = false;
        forceNextInject = false;

        return {
            message: {
                customType: CUSTOM_TYPE,
                content: buildReminder(label, reason),
                display: false,
            },
        };
    });

    pi.registerTool({
        name: "model_identity_status",
        label: "Model Identity Status",
        description: "Show the live model identifier pi is currently running, as seen by the runtime.",
        parameters: { type: "object", properties: {} },
        execute: async (_id, _params, _signal, _onUpdate, ctx) => {
            const label = modelLabel(ctx.model) ?? "(unknown)";
            const m: any = ctx.model ?? {};
            const text =
                `Live model: ${label}\n` +
                `  raw id: ${m.id ?? "(none)"}\n` +
                `  provider: ${m.provider ?? "(none)"}\n` +
                `  last injected identity: ${lastInjectedLabel ?? "(none yet)"}`;
            return { content: [{ type: "text", text }], details: { label, id: m.id, provider: m.provider } };
        },
    });
}
