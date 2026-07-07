/**
 * bash-watchdog.ts
 *
 * WHY: Prevent pi sessions from getting stuck forever in "Working..." when a model
 * launches a foreground server / Windows interop process, or passes a millisecond
 * timeout (e.g. 120000) to pi's bash tool, whose timeout unit is SECONDS.
 *
 * WHAT IT DOES:
 * - Adds a sane default timeout to bash calls with no timeout.
 * - Converts common ms-style timeout mistakes: 120000 -> 120 seconds.
 * - Caps excessively long timeouts.
 * - Uses a shorter cap for likely foreground server / Windows interop commands.
 *
 * NOTIFICATIONS (PI_BASH_WATCHDOG_NOTIFY):
 * - "all" (default): show the effective timeout for EVERY command, BEFORE it runs,
 *   even ones we leave untouched, so you always know up-front how long it can run.
 *   Calm "info" for untouched / benign default-fill / server caps; loud "warning"
 *   only for genuine model mistakes (ms / over-cap).
 * - "corrections": stay silent unless we actually changed something (ms / cap / server).
 * - "off" (or PI_BASH_WATCHDOG_QUIET=1): apply fixes silently, no UI at all.
 *
 * BYPASS for a single command:
 *   # pi-watchdog:disable
 * or include:
 *   PI_BASH_WATCHDOG_DISABLE=1
 *
 * REVERT: delete this file and run `/reload` in pi (or start a new session).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type BashInput = {
  command?: unknown;
  timeout?: unknown;
};

const DEFAULT_TIMEOUT_SEC = readPositiveInt("PI_BASH_WATCHDOG_DEFAULT_SEC", 300);
const MAX_TIMEOUT_SEC = readPositiveInt("PI_BASH_WATCHDOG_MAX_SEC", 900);
const FOREGROUND_TIMEOUT_SEC = readPositiveInt(
  "PI_BASH_WATCHDOG_FOREGROUND_SEC",
  120,
);

type NotifyMode = "all" | "corrections" | "off";
const NOTIFY_MODE: NotifyMode = resolveNotifyMode();

function resolveNotifyMode(): NotifyMode {
  if (process.env.PI_BASH_WATCHDOG_QUIET === "1") return "off";
  const raw = (process.env.PI_BASH_WATCHDOG_NOTIFY || "all").toLowerCase();
  if (raw === "corrections" || raw === "off") return raw;
  return "all";
}

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function isBashTool(name: unknown): boolean {
  return name === "bash" || name === "Shell" || name === "shell";
}

function hasBypass(command: string): boolean {
  return (
    command.includes("pi-watchdog:disable") ||
    command.includes("PI_BASH_WATCHDOG_DISABLE=1")
  );
}

function isProbablyDetached(command: string): boolean {
  const c = command.toLowerCase();
  return (
    /\b(nohup|setsid|disown)\b/.test(c) ||
    /\bstart-process\b/.test(c) ||
    /\bstart-job\b/.test(c) ||
    /\s&\s*(?:#.*)?$/.test(command)
  );
}

function isLikelyForegroundLongRunner(command: string): boolean {
  if (isProbablyDetached(command)) return false;
  const c = command.toLowerCase();
  return (
    /\b(cmd\.exe|powershell(?:\.exe)?)\b/.test(c) ||
    /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve)\b/.test(c) ||
    /\b(uvicorn|gunicorn|fastapi|flask|streamlit|vite|next\s+dev)\b/.test(c) ||
    /\bpython\b.*\b(-m\s+http\.server|server|serve|app\.py)\b/.test(c) ||
    /\bnode\b.*\b(server|serve|standalone)\b/.test(c) ||
    /\btail\s+-f\b/.test(c)
  );
}

type Normalized = {
  value: number;
  msFrom?: number; // original ms-style value the model passed
  cappedFrom?: number; // pre-cap value (in seconds) before MAX clamp
};

function normalizeTimeout(raw: unknown): Normalized {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    // No usable timeout -> benign default fill (not a model mistake).
    return { value: DEFAULT_TIMEOUT_SEC };
  }

  let value = Math.ceil(raw);
  const out: Normalized = { value };

  // pi bash timeout is seconds. Models often pass tool API milliseconds.
  // 120000 should mean 120s, not 33 hours.
  if (value >= 10_000) {
    out.msFrom = raw;
    value = Math.ceil(value / 1000);
  }

  if (value > MAX_TIMEOUT_SEC) {
    out.cappedFrom = value;
    value = MAX_TIMEOUT_SEC;
  }

  out.value = value;
  return out;
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (!isBashTool((event as { toolName?: unknown }).toolName)) return;

    const input = (event as { input?: BashInput }).input;
    if (!input || typeof input !== "object") return;
    const command = typeof input.command === "string" ? input.command : "";
    if (!command || hasBypass(command)) return;

    const before = input.timeout;
    const norm = normalizeTimeout(before);
    let next = norm.value;

    // A "correction" = model passed a real number we had to fix (ms / over-cap).
    // That is the only thing worth a loud warning.
    const corrected = norm.msFrom !== undefined || norm.cappedFrom !== undefined;

    let foregroundCapped = false;
    if (isLikelyForegroundLongRunner(command) && next > FOREGROUND_TIMEOUT_SEC) {
      next = FOREGROUND_TIMEOUT_SEC;
      foregroundCapped = true;
    }

    // Already a sane second value -> don't reassign, but in "all" mode we still
    // surface the effective timeout so the run-time is always visible up-front.
    const unchanged = before === next;
    if (!unchanged) input.timeout = next;

    // --- notification policy ---
    if (NOTIFY_MODE === "off") return;
    // In "corrections" mode, stay silent unless we actually changed something.
    if (NOTIFY_MODE === "corrections" && !corrected && !foregroundCapped) return;

    const tags: string[] = [];
    if (norm.msFrom !== undefined) tags.push(`ms ${norm.msFrom}`);
    if (norm.cappedFrom !== undefined) tags.push(`capped ${norm.cappedFrom}`);
    if (foregroundCapped) tags.push("server");

    const detail = tags.length ? ` · ${tags.join(" · ")}` : "";
    ctx.ui.notify(
      `watchdog ⏱ ${next}s${detail}`,
      corrected ? "warning" : "info",
    );
  });

  pi.registerCommand("bash-watchdog-status", {
    description: "Show bash watchdog timeout policy",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        `bash-watchdog: default=${DEFAULT_TIMEOUT_SEC}s, max=${MAX_TIMEOUT_SEC}s, foreground=${FOREGROUND_TIMEOUT_SEC}s, notify=${NOTIFY_MODE}`,
        "info",
      );
    },
  });
}
