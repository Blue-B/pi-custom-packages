// Replacement for herdr's official Pi state reporter that also keeps the pane
// working while async pi-subagents children owned by this session are live.
//
// This must be the only reporter using herdr's official `herdr:pi` source.
// Running it beside herdr-agent-state.ts creates two independent sequence clocks,
// so installation disables that managed extension through Pi's resource config.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const SOURCE = "herdr:pi";
const POLL_MS = 3000;
const STALE_MS = 10 * 60_000;

type AgentState = "working" | "blocked" | "idle";

type QueuedState = {
  state: AgentState;
  message?: string;
  seq: number;
};

type SessionRefParams = {
  agent_session_id?: string;
  agent_session_path?: string;
};

type HerdrRequest = {
  id: string;
  method: "pane.report_agent" | "pane.report_agent_session";
  params: SessionRefParams & {
    pane_id: string;
    source: string;
    agent: string;
    seq: number;
    state?: AgentState;
    message?: string;
    session_start_source?: string;
  };
};

interface RunStatus {
  sessionId?: string;
  state?: string;
  lastActivityAt?: number;
}

function defaultRunsDir(): string | null {
  const uid = process.getuid?.();
  return uid === undefined
    ? null
    : `/tmp/pi-subagents-uid-${uid}/async-subagent-runs`;
}

/** Number of this session's live async child runs, or null when unknowable. */
export function countLiveRuns(
  sessionPath: string | undefined,
  runsDirectory = defaultRunsDir(),
  now = Date.now(),
): number | null {
  if (!runsDirectory || !sessionPath) return null;

  let entries: string[];
  try {
    entries = fs.readdirSync(runsDirectory);
  } catch {
    return null;
  }

  let live = 0;
  for (const entry of entries) {
    const file = path.join(runsDirectory, entry, "status.json");
    try {
      if (now - fs.statSync(file).mtimeMs > STALE_MS) continue;
    } catch {
      continue;
    }

    try {
      const status = JSON.parse(fs.readFileSync(file, "utf8")) as RunStatus;
      const sessionId = status.sessionId;
      const lastActivityAt = status.lastActivityAt;
      if (
        status.state === "running" &&
        sessionId &&
        path.resolve(sessionId) === path.resolve(sessionPath) &&
        Number.isFinite(lastActivityAt) &&
        now - (lastActivityAt ?? 0) <= STALE_MS
      ) {
        live += 1;
      }
    } catch {
    }
  }

  return live;
}

function sendRequestAttempt(
  socketEndpoint: string,
  request: HerdrRequest,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const socket = net.createConnection(socketEndpoint);
    const finish = (delivered: boolean) => {
      if (done) return;
      done = true;
      if (timeout) clearTimeout(timeout);
      socket.destroy();
      resolve(delivered);
    };

    socket.on("error", () => finish(false));
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", () => finish(true));
    socket.on("end", () => finish(false));
    timeout = setTimeout(() => finish(false), timeoutMs);
    timeout.unref?.();
  });
}

export default function (pi: ExtensionAPI) {
  const socketPath = process.env.HERDR_SOCKET_PATH ?? "";
  const paneId = process.env.HERDR_PANE_ID ?? "";
  if (process.env.HERDR_ENV !== "1" || !socketPath || !paneId) return;

  const socketEndpoint =
    process.platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;

  async function sendRequest(request: HerdrRequest): Promise<void> {
    if (await sendRequestAttempt(socketEndpoint, request, 500)) return;
    await sendRequestAttempt(socketEndpoint, request, 1500);
  }

  let reportSeq = Date.now() * 1000;
  let currentAgentSessionId: string | undefined;
  let currentAgentSessionPath: string | undefined;
  let sendInFlight = false;
  let queuedState: QueuedState | undefined;

  function nextReportSeq(): number {
    reportSeq += 1;
    return reportSeq;
  }

  function updateSessionRef(ctx: ExtensionContext): void {
    try {
      const file = ctx.sessionManager.getSessionFile();
      currentAgentSessionPath = file?.startsWith("/") ? file : undefined;
    } catch {
      currentAgentSessionPath = undefined;
    }

    try {
      currentAgentSessionId = ctx.sessionManager.getSessionId() || undefined;
    } catch {
      currentAgentSessionId = undefined;
    }
  }

  function currentSessionRef(): SessionRefParams | undefined {
    if (currentAgentSessionPath) {
      return { agent_session_path: currentAgentSessionPath };
    }
    if (currentAgentSessionId) {
      return { agent_session_id: currentAgentSessionId };
    }
    return undefined;
  }

  function reportSession(sessionStartSource?: string): Promise<void> {
    const sessionRef = currentSessionRef();
    if (!sessionRef) return Promise.resolve();

    return sendRequest({
      id: `${SOURCE}:session:${Date.now()}:${Math.random().toString(36).slice(2)}`,
      method: "pane.report_agent_session",
      params: {
        pane_id: paneId,
        source: SOURCE,
        agent: "pi",
        seq: nextReportSeq(),
        session_start_source: sessionStartSource,
        ...sessionRef,
      },
    });
  }

  function sendState(
    state: AgentState,
    message?: string,
    seq = nextReportSeq(),
  ): Promise<void> {
    return sendRequest({
      id: `${SOURCE}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
      method: "pane.report_agent",
      params: {
        pane_id: paneId,
        source: SOURCE,
        agent: "pi",
        state,
        message,
        seq,
        ...currentSessionRef(),
      },
    });
  }

  function queueState(state: AgentState, message?: string): void {
    queuedState = { state, message, seq: nextReportSeq() };
    if (!sendInFlight) void drainStateQueue();
  }

  async function drainStateQueue(): Promise<void> {
    if (sendInFlight) return;

    sendInFlight = true;
    try {
      while (queuedState) {
        const next = queuedState;
        queuedState = undefined;
        await sendState(next.state, next.message, next.seq);
      }
    } finally {
      sendInFlight = false;
      if (queuedState) void drainStateQueue();
    }
  }

  let rootSession = false;
  let agentActive = false;
  let blockedCount = 0;
  let blockedMessage: string | undefined;
  let liveChildren = 0;
  let lastState: AgentState | undefined;
  let lastMessage: string | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;

  function childMessage(): string | undefined {
    if (liveChildren === 1) return "서브에이전트 실행 중";
    if (liveChildren > 1) return `서브에이전트 ${liveChildren}개 실행 중`;
    return undefined;
  }

  function desiredState(): { state: AgentState; message?: string } {
    if (blockedCount > 0) {
      return { state: "blocked", message: blockedMessage };
    }
    if (agentActive) return { state: "working" };
    if (liveChildren > 0) {
      return { state: "working", message: childMessage() };
    }
    return { state: "idle" };
  }

  function publishState(force = false): void {
    const next = desiredState();
    if (!force && next.state === lastState && next.message === lastMessage) return;
    lastState = next.state;
    lastMessage = next.message;
    queueState(next.state, next.message);
  }

  function refreshLiveChildren(): void {
    const next = countLiveRuns(currentAgentSessionPath);
    if (next === null || next === liveChildren) return;
    liveChildren = next;
    publishState();
  }

  function startPolling(): void {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(refreshLiveChildren, POLL_MS);
    pollTimer.unref?.();
  }

  pi.events.on("herdr:blocked", (data) => {
    if (!rootSession) return;
    const blocked = data as { active?: boolean; label?: string };
    if (blocked.active) {
      blockedCount += 1;
      blockedMessage = blocked.label;
    } else {
      blockedCount = Math.max(0, blockedCount - 1);
      if (blockedCount === 0) blockedMessage = undefined;
    }
    publishState();
  });

  pi.on("session_start", async (event, ctx) => {
    if (ctx.mode !== "tui") return;

    rootSession = true;
    updateSessionRef(ctx);
    liveChildren = countLiveRuns(currentAgentSessionPath) ?? 0;
    await reportSession(event.reason === "reload" ? "resume" : event.reason);
    agentActive = ctx.isIdle() === false;
    startPolling();
    publishState(true);
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!rootSession) return;
    updateSessionRef(ctx);
    void reportSession();
    agentActive = true;
    publishState();
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (!rootSession || ctx.isIdle() !== true) return;
    const next = countLiveRuns(currentAgentSessionPath);
    if (next !== null) liveChildren = next;
    agentActive = false;
    publishState();
  });

  pi.on("session_shutdown", () => {
    rootSession = false;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = undefined;
  });
}
