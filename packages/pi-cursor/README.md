# pi-cursor

> Let your WSL-hosted [pi coding agent](https://github.com/earendil-works/pi-coding-agent) drive the **Windows mouse and keyboard** — focus a window, move the cursor with natural easing, click, and type.

**Zero external dependencies.** No AutoHotkey, no nircmd, no Python, no native modules. Just `powershell.exe` + .NET that already ship with Windows.

## Why

A WSL agent can read files and run commands, but it cannot touch the Windows desktop. That gap shows up the moment you want it to demo something: click through a UI you are recording, focus the right window before a screenshot, or type into a native app.

`pi-cursor` bridges WSL to the Windows input stack so the agent can do those steps itself.

Pairs well with [pi-winshot](../pi-winshot) (see the screen) and [pi-recordly](../pi-recordly) (record the result).

## Tools

| Tool | What it does |
|------|--------------|
| `cursor_focus_window` | Bring a window to the foreground by title substring or process name. Reports which window actually ended up in front, so you can verify focus landed correctly. |
| `cursor_move` | Move the cursor to absolute screen coordinates, interpolating over a duration so the motion looks natural on a recording. |
| `cursor_click` | Click at the current position. Left or right button, single or double. |
| `cursor_type` | Type text into whatever window has keyboard focus. |
| `cursor_position` | Read the current cursor coordinates. |

## Install

```bash
git clone https://github.com/Blue-B/pi-custom-packages.git
cd pi-custom-packages
pi install ./packages/pi-cursor
```

Then run `/reload` in pi.

## Usage

Always focus the target window first — a click lands wherever the foreground is, not wherever you last looked.

```
cursor_focus_window { "title": "Chrome" }
cursor_move { "x": 820, "y": 460, "durationMs": 400 }
cursor_click {}
cursor_type { "text": "hello" }
```

Coordinates are absolute screen pixels with the origin at the top-left of the virtual desktop. Use `pi-winshot` to capture the screen and work out the target pixel first.

## Notes

- `cursor_type` uses PowerShell `SendKeys`, which sends to the focused window. It does not carry Unicode reliably for every layout; for non-ASCII text, set the clipboard and paste instead.
- Motion is interpolated in PowerShell, so very short durations still take a few tens of milliseconds per step.
- On a multi-monitor setup, coordinates can be negative when a monitor sits left of or above the primary one.

## Requirements

- Windows 10/11 with WSL2, interop enabled (`powershell.exe` reachable from WSL)
- [pi coding agent](https://github.com/earendil-works/pi-coding-agent), tested on 0.84
- Node.js >= 18

## License

MIT © [Blue-B](https://github.com/Blue-B)
