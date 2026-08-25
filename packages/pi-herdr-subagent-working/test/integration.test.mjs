import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const extensionPath = path.resolve(
  "extensions/pi-herdr-subagent-working/index.ts",
);

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for request");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function writeStatus(directory, name, status) {
  const runDirectory = path.join(directory, name);
  fs.mkdirSync(runDirectory, { recursive: true });
  fs.writeFileSync(path.join(runDirectory, "status.json"), JSON.stringify(status));
}

test("uses one official Herdr source for parent and async child state", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-state-test-"));
  const socketPath = path.join(sandbox, "herdr.sock");
  const sessionPath = path.join(sandbox, "session.jsonl");
  const now = Date.now();
  const requests = [];
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const request = JSON.parse(line);
        requests.push(request);
        socket.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
      }
    });
  });

  const realRunsDirectory = `/tmp/pi-subagents-uid-${process.getuid()}/async-subagent-runs`;
  const runName = `pi-herdr-state-test-${process.pid}-${now}`;
  const runDirectory = path.join(realRunsDirectory, runName);
  const previousEnv = {
    HERDR_ENV: process.env.HERDR_ENV,
    HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH,
    HERDR_PANE_ID: process.env.HERDR_PANE_ID,
  };

  try {
    fs.writeFileSync(sessionPath, "");
    const fixtureRuns = path.join(sandbox, "runs");
    writeStatus(fixtureRuns, "live", {
      sessionId: sessionPath,
      state: "running",
      lastActivityAt: now,
    });
    writeStatus(fixtureRuns, "other-session", {
      sessionId: `${sessionPath}.other`,
      state: "running",
      lastActivityAt: now,
    });
    writeStatus(fixtureRuns, "complete", {
      sessionId: sessionPath,
      state: "complete",
      lastActivityAt: now,
    });
    writeStatus(fixtureRuns, "stale", {
      sessionId: sessionPath,
      state: "running",
      lastActivityAt: now - 11 * 60_000,
    });

    const moduleUrl = pathToFileURL(extensionPath);
    moduleUrl.searchParams.set("test", `${process.pid}-${now}`);
    const { countLiveRuns, default: extension } = await import(moduleUrl.href);
    assert.equal(countLiveRuns(sessionPath, fixtureRuns, now), 1);

    writeStatus(realRunsDirectory, runName, {
      sessionId: sessionPath,
      state: "running",
      lastActivityAt: Date.now(),
    });

    process.env.HERDR_ENV = "1";
    process.env.HERDR_SOCKET_PATH = socketPath;
    process.env.HERDR_PANE_ID = "w-test:p1";
    server.listen(socketPath);
    await once(server, "listening");

    const handlers = new Map();
    const eventHandlers = new Map();
    const addHandler = (map, name, handler) => {
      const registered = map.get(name) ?? [];
      registered.push(handler);
      map.set(name, registered);
    };
    const pi = {
      on(name, handler) {
        addHandler(handlers, name, handler);
      },
      events: {
        on(name, handler) {
          addHandler(eventHandlers, name, handler);
        },
      },
    };
    const emit = async (name, event, context) => {
      for (const handler of handlers.get(name) ?? []) {
        await handler(event, context);
      }
    };
    const context = {
      mode: "tui",
      isIdle: () => true,
      sessionManager: {
        getSessionFile: () => sessionPath,
        getSessionId: () => "test-session-id",
      },
    };

    extension(pi);
    await emit("session_start", { reason: "startup" }, context);
    await waitFor(() => requests.length >= 2);

    const sessionReport = requests.find(
      (request) => request.method === "pane.report_agent_session",
    );
    const workingReport = requests.find(
      (request) =>
        request.method === "pane.report_agent" &&
        request.params.state === "working",
    );
    assert.ok(sessionReport);
    assert.ok(workingReport);
    assert.equal(workingReport.params.message, "서브에이전트 실행 중");
    assert.equal(workingReport.params.agent_session_path, sessionPath);

    writeStatus(realRunsDirectory, runName, {
      sessionId: sessionPath,
      state: "complete",
      lastActivityAt: Date.now(),
    });
    await emit("agent_settled", {}, context);
    await waitFor(() =>
      requests.some(
        (request) =>
          request.method === "pane.report_agent" &&
          request.params.state === "idle",
      ),
    );
    await emit("session_shutdown", { reason: "quit" }, context);

    assert.ok(
      requests.every((request) => request.params.source === "herdr:pi"),
    );
    assert.ok(
      requests.every(
        (request) => request.method !== "pane.clear_agent_authority",
      ),
    );
    const sequences = requests.map((request) => request.params.seq);
    assert.deepEqual(sequences, [...sequences].sort((left, right) => left - right));
    assert.equal(new Set(sequences).size, sequences.length);
  } finally {
    fs.rmSync(runDirectory, { recursive: true, force: true });
    if (server.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
    fs.rmSync(sandbox, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
