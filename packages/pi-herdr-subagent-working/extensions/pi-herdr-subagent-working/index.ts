// herdr's official Pi integration (herdr-agent-state.ts, installed by
// `herdr integration install pi`) only tracks this process's agent_start /
// agent_settled lifecycle. The moment the parent turn ends, the pane flips to
// "idle"/done even though an async subagent child is still running in a
// separate headless process, and the token counters freeze with it.
//
// This extension polls pi-subagents' async run state and reports "working"
// to herdr over its Unix socket while one of THIS session's children is live.
//
// It deliberately reports under a separate source id ("herdr:pi-subagents")
// instead of reusing "herdr:pi": herdr keeps per-source monotonic sequence
// numbers and rejects anything older, so a second reporter on the official
// source would permanently poison the integration's future reports.
// When the last child finishes we release our authority again so the official
// integration stays in charge.
//
// Same bug class tracked upstream:
// https://github.com/herdrdev/herdr/issues/2354 (agy panes report idle)
// https://github.com/herdrdev/herdr/issues/3052 (OpenCode subagent states)
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SOURCE = "herdr:pi-subagents";
const POLL_MS = 3000;
const HEARTBEAT_MS = 15000;
// Runs whose writer stopped touching status.json for this long are treated as
// crashed, not running. Prevents a stuck "working" forever.
const STALE_MS = 10 * 60_000;

interface RunStatus {
  sessionId?: string;
  state?: string;
  lastActivityAt?: number;
}

interface SessionRef {
  getSessionFile?: () => unknown;
}

function runsDir(): string | null {
  if (typeof process.getuid !== "function") return null;
  return `/tmp/pi-subagents-uid-${process.getuid()}/async-subagent-runs`;
}

/** Number of this session's live async child runs, or null when unknowable. */
function countLiveRuns(sessionPath: string | undefined): number | null {
  const dir = runsDir();
  if (!dir || !sessionPath) return null;
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  let live = 0;
  const now = Date.now();
  for (const entry of entries) {
    const file = path.join(dir, entry, "status.json");
    // Finished runs never get rewritten; skip them without reading.
    try {
      if (now - fs.statSync(file).mtimeMs > STALE_MS) continue;
    } catch {
      continue;
    }
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    let status: RunStatus;
    try {
      status = JSON.parse(raw) as RunStatus;
    } catch {
      continue;
    }
    if (status.state !== "running") continue;
    if (
      typeof status.sessionId !== "string" ||
      path.resolve(status.sessionId) !== path.resolve(sessionPath)
    ) {
      continue;
    }
    if (
      typeof status.lastActivityAt !== "number" ||
      now - status.lastActivityAt > STALE_MS
    ) {
      continue;
    }
    live += 1;
  }
  return live;
}

let seq = Date.now() * 1000;

function sendOnce(socketPath: string, request: unknown): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const socket = net.createConnection(socketPath);
    const finish = (delivered: boolean) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(delivered);
    };
    socket.on("error", () => finish(false));
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", () => finish(true));
    socket.on("end", () => finish(false));
    setTimeout(() => finish(false), 800).unref?.();
  });
}

async function report(
  socketPath: string,
  paneId: string,
  state: "working" | "idle",
  message?: string,
): Promise<boolean> {
  // No agent_session_* fields on purpose: claiming the pane's session under a
  // second source can trip herdr's session-owner conflict checks.
  const params: Record<string, unknown> = {
    pane_id: paneId,
    source: SOURCE,
    agent: "pi",
    state,
    seq: ++seq,
  };
  if (message) params.message = message;
  const request = {
    id: `${SOURCE}:${Date.now()}:${seq}`,
    method: "pane.report_agent",
    params,
  };
  return (await sendOnce(socketPath, request)) || sendOnce(socketPath, request);
}

async function releaseAuthority(
  socketPath: string,
  paneId: string,
): Promise<void> {
  await report(socketPath, paneId, "idle");
  const request = {
    id: `${SOURCE}:clear:${Date.now()}:${seq}`,
    method: "pane.clear_agent_authority",
    params: { pane_id: paneId, source: SOURCE, seq: ++seq },
  };
  await sendOnce(socketPath, request);
}

export default function (pi: ExtensionAPI) {
  const socketPath = process.env.HERDR_SOCKET_PATH;
  const paneId = process.env.HERDR_PANE_ID;
  if (process.env.HERDR_ENV !== "1" || !socketPath || !paneId) return;

  let sessionPath: string | undefined;
  let parentActive = false;
  let reporting = false;
  let lastSent = 0;

  pi.on("session_start", (_event, ctx) => {
    if ((ctx as { mode?: string } | undefined)?.mode !== "tui") return;
    const manager = (ctx as { sessionManager?: SessionRef } | undefined)
      ?.sessionManager;
    try {
      const file = manager?.getSessionFile?.();
      if (typeof file === "string") sessionPath = file;
    } catch {
      sessionPath = undefined;
    }
  });

  pi.on("agent_start", () => {
    parentActive = true;
  });

  pi.on("agent_settled", (_event, ctx) => {
    const idle = (ctx as { isIdle?: () => boolean } | undefined)?.isIdle?.();
    if (idle === true) parentActive = false;
  });

  setInterval(async () => {
    const live = countLiveRuns(sessionPath);
    if (live === null) return;
    const now = Date.now();
    if (live > 0) {
      if (!reporting || now - lastSent >= HEARTBEAT_MS) {
        reporting = true;
        lastSent = now;
        await report(
          socketPath!,
          paneId!,
          "working",
          live === 1
            ? "서브에이전트 실행 중"
            : `서브에이전트 ${live}개 실행 중`,
        );
      }
    } else if (reporting) {
      reporting = false;
      if (!parentActive) {
        await releaseAuthority(socketPath!, paneId!);
      }
    }
  }, POLL_MS).unref?.();
}
