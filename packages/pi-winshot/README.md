# pi-winshot

> Let your WSL-hosted [pi coding agent](https://github.com/earendil-works/pi) see and edit your **Windows desktop** — capture any window (even when occluded), crop, resize, and mask sensitive regions for safe sharing.

**Zero external dependencies.** No nircmd, no ShareX, no Python, no Node native modules. Just `powershell.exe` + .NET `System.Drawing` that already ship with Windows.

## Why

WSL-based AI agents (pi, Claude Code in WSL, Codex, opencode, …) live in a Linux box that can't see the Windows host. Existing screenshot tools either:

- only work on native Linux desktops (Sway/Hyprland/etc.), or
- require the user to capture manually and paste into the prompt.

`pi-winshot` bridges WSL → Windows so the agent itself can grab the screen, refine the region, and mask private info before showing or attaching the result.

## Features

- **Modes** — `full`, `region`, `monitor`, `active`, `window`.
- **Occlusion-safe** — `mode=window` uses `PrintWindow + PW_RENDERFULLCONTENT`, so a Chrome/Edge/Whale window buried behind 5 terminals captures cleanly without disturbing your desktop.
- **Multi-monitor aware** — virtual-desktop bounds for `full`, per-monitor capture for `monitor`.
- **Edits** — `crop`, `resize`, and **mask** (`black` / `pixelate` / `blur`) one or many rectangles.
- **AI-native** — tools are registered with the pi agent so the model can call them directly, look at the result, recompute coordinates, and re-crop until it lands the region you asked for.
- **Korean / Unicode-safe** — window titles round-trip via UTF-8.

## Install

```bash
git clone https://github.com/Blue-B/pi-custom-packages.git
cd pi-custom-packages
pi install ./packages/pi-winshot
```

Then run `/reload` in pi.

### Requirements

- Windows 10 / 11 host with `powershell.exe` on `PATH` (the default).
- WSL2 distro (any). `pi-winshot` autodetects WSL via `/proc/version`.
- pi coding agent, tested on 0.84.

## Usage

### Natural language

- "Take a screenshot of my Chrome window"
- "Capture the active window"
- "Show me the right half of my main monitor"
- "Crop that screenshot to just the terminal in the top-left"
- "Mask the API key in the middle of this image, then save"

The agent calls these tools under the hood:

| Tool | Purpose |
| --- | --- |
| `winshot_list_windows` | enumerate visible top-level windows |
| `winshot_list_monitors` | enumerate connected monitors |
| `winshot_capture` | capture `full` / `region` / `monitor` / `active` / `window` |
| `winshot_crop` | crop a PNG by pixel rect |
| `winshot_mask` | redact regions (`black` / `pixelate` / `blur`) |
| `winshot_resize` | downscale large captures before LLM round-trip |
| `winshot_info` | report PNG dimensions |

### Slash commands

```
/winshot               # full screen
/winshot active        # active window
/winshot window CHZZK  # any window whose title contains "CHZZK"
/winshot list          # list windows so you can pick one
```

### Direct PowerShell (no pi)

The PowerShell scripts work standalone too:

```powershell
# capture
powershell.exe -NoProfile -ExecutionPolicy Bypass -File 'C:\path\to\scripts\capture.ps1' `
    -Mode window -Title 'CHZZK' -Out 'C:\tmp\shot.png' -Json

# crop
powershell.exe ... '...\edit.ps1' -Op crop -In '...\shot.png' -Out '...\out.png' `
    -X 100 -Y 100 -W 800 -H 600 -Json

# mask (pixelate two regions)
powershell.exe ... '...\edit.ps1' -Op mask -In '...\shot.png' -Out '...\out.png' `
    -Regions '50,50,400,200;800,500,300,150' -MaskStyle pixelate -Json
```

## How occlusion-safe capture works

The `window` mode does not call `BitBlt`-on-screen. It calls Win32 `PrintWindow(hWnd, hdc, PW_RENDERFULLCONTENT=0x2)`, which asks the window itself to render into our bitmap. That bypasses Z-order, so even windows fully covered by other apps come out fully painted — including hardware-accelerated browsers.

```
+-------------------+
|  Terminal (front) |   <- this is what your eyes see
|   +------------+  |
|   | Browser    |  |
|   | (occluded) |  |   <- PrintWindow captures THIS, unaltered
|   +------------+  |
+-------------------+
```

Caveats:

- Minimized windows → pass `bring_to_front=true` so we `ShowWindow(SW_RESTORE)` first.
- DRM-protected video (Netflix, some players) → returns a black frame; this is a Windows DRM property, not a bug.
- A handful of OpenGL/legacy games render via direct presentation and produce partial-black output — fall back to `bring_to_front=true`.

## Privacy / masking

Before sharing a screenshot externally, ask the agent to mask anything sensitive:

```
"Mask the URL bar and the file path in the bottom-left, then resize to 1200px wide."
```

The agent will use `winshot_info` to get dimensions, `winshot_mask` with `style=black` (or `pixelate` / `blur`), and `winshot_resize`. All three operations are in-process .NET — no temp uploads, no cloud, files stay on your disk.

## Project layout

```
pi-winshot/
├── package.json
├── extensions/winshot/index.ts     # registers tools + /winshot command
├── skills/winshot/SKILL.md         # decision flow guide for the model
├── scripts/
│   ├── capture.ps1                 # capture engine (mode dispatcher)
│   ├── edit.ps1                    # crop / mask / resize / info
│   ├── list.ps1                    # list windows / monitors
│   └── lib.ps1                     # P/Invoke + helpers (shared)
└── README.md
```

## License

MIT
