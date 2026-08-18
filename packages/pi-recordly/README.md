# pi-recordly

> Let your WSL-hosted [pi coding agent](https://github.com/earendil-works/pi-coding-agent) drive [Recordly](https://recordly.dev) on Windows — start and stop screen recordings, pick a window or a screen as the source, and read status.

**Zero external dependencies.** Talks to the Recordly app over WSL interop; nothing extra to install on the Linux side.

## Why

Screenshots prove a state. A recording proves a flow. When the agent has just wired something up, the honest way to show it works is to record the thing running.

`pi-recordly` lets the agent start the recorder before it demonstrates, and stop it after, without you reaching for the mouse.

Pairs well with [pi-cursor](../pi-cursor) (drive the demo) and [pi-winshot](../pi-winshot) (still frames).

## Tools

| Tool | What it does |
|------|--------------|
| `recordly_start` | Start recording. Optionally target a window by title substring, and optionally capture system audio. |
| `recordly_stop` | Stop the recording and return the saved `.mp4` path. |
| `recordly_status` | Report whether a recording is running and where the file will land. |
| `recordly_sources` | List screens and windows Recordly can record, with ids and names. |
| `recordly_quit` | Quit the Recordly app. |

## Install

```bash
pi install https://github.com/Blue-B/pi-custom-packages/tree/main/packages/pi-recordly
```

Then run `/reload` in pi.

## Usage

Record a single window rather than the whole screen when you can. The window source captures only that window's pixels, so whatever else is on your desktop stays out of the file.

```
recordly_sources {}
recordly_start { "sourceName": "Chrome" }
... do the thing ...
recordly_stop {}
```

## Cursor and auto-zoom

Recordly writes the cursor track to a sidecar `<recording>.mp4.cursor.json` instead of burning a pointer into the video. The recorded `.mp4` therefore looks like it has no cursor. That is expected: open the clip in the Recordly editor and the cursor and auto-zoom are applied there, then baked in on export.

Auto-zoom keys off interaction, so a recording where nothing is clicked stays flat. If you are driving the demo with `pi-cursor`, include real clicks and typing rather than only moving the pointer.

## Requirements

- Windows 10/11 with WSL2, interop enabled
- [Recordly](https://recordly.dev) installed on Windows
- [pi coding agent](https://github.com/earendil-works/pi-coding-agent) >= 0.70
- Node.js >= 18

## License

MIT © [Blue-B](https://github.com/Blue-B)
