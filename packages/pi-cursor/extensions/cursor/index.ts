import { execFile } from "node:child_process";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// Windows mouse/keyboard automation for scripted demos (e.g. moving to and
// clicking a UI element while Recordly is recording). Runs powershell.exe
// directly via WSL interop, bypassing cmd.exe entirely so there is no shell
// quoting to get wrong and no user cmd.exe wrapper to false-positive on.
//
// Safety rule: cursor_click and cursor_type must always follow a successful
// cursor_focus_window call. The focus tool fails hard when it cannot bring
// the requested window to the foreground, so blind clicks/typing into
// whatever happens to be on top cannot happen.
const IS_WSL =
  process.platform === "linux" && Boolean(process.env.WSL_DISTRO_NAME);
const POWERSHELL = IS_WSL
  ? "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
  : "powershell.exe";

function runPowerShell(script: string): Promise<string> {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((resolve, reject) => {
    execFile(
      POWERSHELL,
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encoded,
      ],
      {
        windowsHide: true,
        timeout: 30_000,
        cwd: IS_WSL ? "/mnt/c" : undefined,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

// SendKeys treats + ^ % ~ ( ) { } [ ] as control characters; wrap each in
// braces so cursor_type sends them as literal text.
function escapeSendKeys(text: string): string {
  return text.replace(/([+^%~(){}[\]])/g, "{$1}");
}

function psStringLiteral(text: string): string {
  const escaped = text
    .replace(/`/g, "``")
    .replace(/"/g, '`"')
    .replace(/\$/g, "`$");
  return `"${escaped}"`;
}

const MOUSE_EVENT_TYPE = `Add-Type @"
using System;
using System.Runtime.InteropServices;
public class PiMouse {
    [DllImport("user32.dll")]
    public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
}
"@`;

const FOREGROUND_READER = `Add-Type @"
using System;
using System.Runtime.InteropServices;
public class PiWin {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
}
"@
$h = [PiWin]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 256
[void][PiWin]::GetWindowText($h, $sb, 256)
$foregroundTitle = $sb.ToString()`;

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "cursor_focus_window",
    label: "Cursor: focus window",
    description:
      "Bring a window to the foreground by window title substring or process name (e.g. 'Chrome', 'notepad'). Always call this before cursor_click or cursor_type. Fails with an error if the window cannot be focused, and reports the window that actually ended up in front so you can verify focus landed correctly.",
    parameters: Type.Object({
      title: Type.String({
        description: "Window title substring or process name to activate",
      }),
    }),
    async execute(_id, params) {
      const target = psStringLiteral(params.title);
      const script = `$ws = New-Object -ComObject WScript.Shell
$p = Get-Process | Where-Object { $_.MainWindowTitle -like "*${target.substring(1, target.length - 2)}*" } | Select-Object -First 1
if (-not $p) {
	$p = Get-Process -Name ${target} -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
}
if (-not $p) {
	Write-Output "False|no matching window"
	exit
}
$ok = $ws.AppActivate($p.Id)
Start-Sleep -Milliseconds 500
${FOREGROUND_READER}
Write-Output "$ok|$foregroundTitle"`;
      const out = await runPowerShell(script);
      const sep = out.indexOf("|");
      const ok = out.slice(0, sep) === "True";
      const focusedTitle = out.slice(sep + 1);
      if (!ok) {
        throw new Error(
          `Could not focus "${params.title}". Front window is: ${focusedTitle || "unknown"}. Pick a different title/process or ask the user to bring the window up.`,
        );
      }
      return {
        content: [{ type: "text", text: `Focused: ${focusedTitle}` }],
        details: { ok, focusedTitle },
      };
    },
  });

  pi.registerTool({
    name: "cursor_move",
    label: "Cursor: move",
    description:
      "Smoothly move the Windows mouse cursor to absolute screen coordinates (top-left origin), interpolating over durationMs so the motion looks natural on a Recordly recording. Use winshot_capture first to find target pixel coordinates on screen.",
    parameters: Type.Object({
      x: Type.Number({ description: "Target X coordinate in screen pixels" }),
      y: Type.Number({ description: "Target Y coordinate in screen pixels" }),
      durationMs: Type.Optional(
        Type.Number({
          description: "Move duration in ms (default 400, 0 for instant jump)",
        }),
      ),
    }),
    async execute(_id, params) {
      const duration = params.durationMs ?? 400;
      const script = `Add-Type -AssemblyName System.Windows.Forms
$target = New-Object System.Drawing.Point(${Math.round(params.x)}, ${Math.round(params.y)})
$start = [System.Windows.Forms.Cursor]::Position
$steps = [Math]::Max(1, [Math]::Round(${duration} / 15))
for ($i = 1; $i -le $steps; $i++) {
	$t = $i / $steps
	$nx = [int]($start.X + ($target.X - $start.X) * $t)
	$ny = [int]($start.Y + ($target.Y - $start.Y) * $t)
	[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point($nx, $ny)
	Start-Sleep -Milliseconds 15
}
[System.Windows.Forms.Cursor]::Position = $target
Write-Output "ok"`;
      await runPowerShell(script);
      return {
        content: [
          { type: "text", text: `Moved cursor to (${params.x}, ${params.y})` },
        ],
        details: { x: params.x, y: params.y },
      };
    },
  });

  pi.registerTool({
    name: "cursor_click",
    label: "Cursor: click",
    description:
      "Click the mouse at its current position. Call cursor_focus_window first so the click lands in the intended window.",
    parameters: Type.Object({
      button: Type.Optional(
        Type.Union([Type.Literal("left"), Type.Literal("right")], {
          description: "Mouse button (default left)",
        }),
      ),
      double: Type.Optional(
        Type.Boolean({ description: "Double-click (default false)" }),
      ),
    }),
    async execute(_id, params) {
      const isRight = params.button === "right";
      const down = isRight ? "0x08" : "0x02";
      const up = isRight ? "0x10" : "0x04";
      const singleClick = `[PiMouse]::mouse_event(${down}, 0, 0, 0, [UIntPtr]::Zero)\nStart-Sleep -Milliseconds 40\n[PiMouse]::mouse_event(${up}, 0, 0, 0, [UIntPtr]::Zero)`;
      const script = `${MOUSE_EVENT_TYPE}\n${singleClick}${
        params.double ? `\nStart-Sleep -Milliseconds 60\n${singleClick}` : ""
      }\nWrite-Output "ok"`;
      await runPowerShell(script);
      return {
        content: [
          {
            type: "text",
            text: `Clicked (${params.button ?? "left"}${params.double ? ", double" : ""})`,
          },
        ],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "cursor_type",
    label: "Cursor: type text",
    description:
      "Type text into whatever window currently has keyboard focus (uses Windows SendKeys). Call cursor_focus_window first, click into the target field with cursor_click, then call this.",
    parameters: Type.Object({
      text: Type.String({ description: "Text to type" }),
    }),
    async execute(_id, params) {
      const literal = psStringLiteral(escapeSendKeys(params.text));
      const script = `Add-Type -AssemblyName System.Windows.Forms\n[System.Windows.Forms.SendKeys]::SendWait(${literal})\nWrite-Output "ok"`;
      await runPowerShell(script);
      return {
        content: [
          { type: "text", text: `Typed ${params.text.length} characters` },
        ],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "cursor_position",
    label: "Cursor: get position",
    description: "Get the Windows mouse cursor's current screen coordinates.",
    parameters: Type.Object({}),
    async execute() {
      const script = `Add-Type -AssemblyName System.Windows.Forms\n$p = [System.Windows.Forms.Cursor]::Position\nWrite-Output "$($p.X),$($p.Y)"`;
      const out = await runPowerShell(script);
      const [x, y] = out.split(",").map(Number);
      return {
        content: [{ type: "text", text: `(${x}, ${y})` }],
        details: { x, y },
      };
    },
  });
}
