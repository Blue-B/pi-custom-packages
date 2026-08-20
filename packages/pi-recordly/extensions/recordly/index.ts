import { execFile, spawn } from "node:child_process";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const RECORDLY_URL = process.env.RECORDLY_URL ?? "http://127.0.0.1:17373";
// Optional Windows path to a local Recordly source checkout. When set, the
// extension starts it with `npm run dev` on first use instead of requiring the
// app to be already running. Unset means "never auto-start".
const RECORDLY_PROJECT_DIR = process.env.RECORDLY_PROJECT_DIR ?? "";

// Pi runs in WSL here; Windows-side 127.0.0.1 is not reachable from WSL
// (localhost relay is off), so requests go through the Windows curl.exe via
// WSL interop. Plain fetch is used on Windows-native or macOS hosts.
const IS_WSL =
  process.platform === "linux" && Boolean(process.env.WSL_DISTRO_NAME);
const WINDOWS_CURL = "/mnt/c/Windows/System32/curl.exe";

function windowsCurl(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      WINDOWS_CURL,
      args,
      { windowsHide: true, timeout: 90_000, cwd: "/mnt/c" },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

// Recordly's dev app is not kept running in the background (it costs GPU +
// memory idle for no reason). Launch it lazily on first use, then auto-quit
// it after IDLE_QUIT_MS of no recordly_* calls so it doesn't linger forever.
// recordly_quit is still exposed for an immediate manual shutdown.
const IDLE_QUIT_MS = 30_000;
let launchAttempted = false;
let idleQuitTimer: ReturnType<typeof setTimeout> | null = null;

function cancelIdleQuit(): void {
  if (idleQuitTimer) {
    clearTimeout(idleQuitTimer);
    idleQuitTimer = null;
  }
}

function scheduleIdleQuit(): void {
  cancelIdleQuit();
  idleQuitTimer = setTimeout(() => {
    idleQuitTimer = null;
    void quitRecordly();
  }, IDLE_QUIT_MS);
}

async function quitRecordly(): Promise<boolean> {
  cancelIdleQuit();
  if (!(await isHealthy())) {
    return false;
  }
  const killCommand =
    "taskkill /F /IM Recordly.exe /T & taskkill /F /IM electron.exe /T";
  await new Promise<void>((resolve) => {
    execFile(
      "cmd.exe",
      ["/d", "/c", killCommand],
      {
        windowsHide: true,
        cwd: IS_WSL ? "/mnt/c" : undefined,
        timeout: 15_000,
      },
      () => resolve(),
    );
  });
  launchAttempted = false;
  return true;
}

async function isHealthy(): Promise<boolean> {
  try {
    const args = ["-s", "-m", "3", `${RECORDLY_URL}/health`];
    let raw: string;
    if (IS_WSL) {
      raw = await windowsCurl(args);
    } else {
      const res = await fetch(`${RECORDLY_URL}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      raw = await res.text();
    }
    return JSON.parse(raw).ok === true;
  } catch {
    return false;
  }
}

function launchRecordlyDev(): void {
  const command = `cd /d ${RECORDLY_PROJECT_DIR} && npm run dev`;
  if (IS_WSL) {
    const child = spawn("cmd.exe", ["/d", "/c", command], {
      windowsHide: true,
      cwd: "/mnt/c",
      stdio: "ignore",
      detached: true,
    });
    child.unref();
  } else {
    const child = spawn("cmd.exe", ["/d", "/c", command], {
      windowsHide: true,
      cwd: RECORDLY_PROJECT_DIR,
      stdio: "ignore",
      detached: true,
    });
    child.unref();
  }
}

async function ensureRunning(): Promise<void> {
  if (await isHealthy()) {
    return;
  }
  if (!RECORDLY_PROJECT_DIR) {
    throw new Error(
      `Recordly is not responding at ${RECORDLY_URL}. Start the Recordly app first, ` +
        "or set RECORDLY_PROJECT_DIR to a local Recordly checkout so this extension can start it.",
    );
  }
  if (!launchAttempted) {
    launchAttempted = true;
    launchRecordlyDev();
  }
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    if (await isHealthy()) {
      return;
    }
  }
  throw new Error(
    "Recordly did not become ready within 90s. It may still be starting (first cold start can be slow) \u2014 try again, or check that the project at " +
      RECORDLY_PROJECT_DIR +
      " is set up.",
  );
}

async function call(pathname: string, body?: unknown): Promise<unknown> {
  if (pathname !== "/health") {
    cancelIdleQuit();
    await ensureRunning();
  }
  if (!IS_WSL) {
    const res = await fetch(`${RECORDLY_URL}${pathname}`, {
      method: body === undefined ? "GET" : "POST",
      headers:
        body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Recordly error: ${res.status}`);
    }
    return res.json();
  }

  const args = ["-s", "-m", "60"];
  if (body === undefined) {
    args.push(`${RECORDLY_URL}${pathname}`);
  } else {
    args.push(
      "-X",
      "POST",
      `${RECORDLY_URL}${pathname}`,
      "-H",
      "content-type: application/json",
      "-d",
      JSON.stringify(body),
    );
  }
  const raw = await windowsCurl(args);
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(
      `Recordly returned a non-JSON response: ${raw.slice(0, 200)}`,
    );
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "recordly_start",
    label: "Recordly: start recording",
    description:
      "Start a Recordly screen recording. Use this right before demonstrating or visually verifying UI work, then call recordly_stop after. Do not record setup or dependency installation. Optionally pass sourceName (window title substring, e.g. Chrome) or systemAudio (true to capture system sound).",
    parameters: Type.Object({
      sourceName: Type.Optional(
        Type.String({
          description:
            "Window title substring or source name to record (default: primary screen)",
        }),
      ),
      systemAudio: Type.Optional(
        Type.Boolean({
          description: "Capture system audio too (default false)",
        }),
      ),
    }),
    async execute(_id, params) {
      const result = await call("/recording/start", {
        sourceName: params.sourceName,
        systemAudio: params.systemAudio,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "recordly_stop",
    label: "Recordly: stop recording",
    description:
      "Stop the current Recordly recording and return the recorded video file path. The file is then ready in Recordly's editor for auto-zoom and export. Recordly auto-quits after a short idle period to free resources, and relaunches automatically on the next recordly_start.",
    parameters: Type.Object({}),
    async execute() {
      const result = await call("/recording/stop", {});
      scheduleIdleQuit();
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "recordly_status",
    label: "Recordly: recording status",
    description:
      "Check whether Recordly is currently recording and where the file will land.",
    parameters: Type.Object({}),
    async execute() {
      const result = await call("/recording/status");
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "recordly_sources",
    label: "Recordly: list recordable sources",
    description:
      "List screens and windows Recordly can record, with their ids and names.",
    parameters: Type.Object({}),
    async execute() {
      const result = await call("/sources");
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "recordly_quit",
    label: "Recordly: quit app",
    description:
      "Immediately close the Recordly app to free up memory and GPU resources, instead of waiting for the automatic idle shutdown. It relaunches automatically next time recordly_start is called.",
    parameters: Type.Object({}),
    async execute() {
      const wasRunning = await quitRecordly();
      return {
        content: [
          {
            type: "text",
            text: wasRunning ? "Recordly closed." : "Recordly is not running.",
          },
        ],
        details: { wasRunning },
      };
    },
  });
}
