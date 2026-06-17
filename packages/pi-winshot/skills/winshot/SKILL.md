---
name: winshot
description: Capture and edit the Windows host screen from a WSL-hosted pi agent. Includes occlusion-safe window capture, region crop, and privacy masking (black/blur/pixelate). Invoke when the user asks to "screenshot", "capture screen", "look at my screen", "mask/blur/hide this part", or "crop this image".
---

# winshot

Capture and edit screenshots of the **Windows host** from inside a WSL pi session. Zero external dependencies — uses `powershell.exe` and .NET `System.Drawing` that ship with Windows.

## Tools

- `winshot_list_windows` — discover visible windows (handle, title, size, minimized).
- `winshot_list_monitors` — list connected monitors with virtual-desktop coordinates.
- `winshot_capture` — capture **full / region / monitor / active / window**. `mode=window` uses `PrintWindow + PW_RENDERFULLCONTENT` so it captures **occluded** windows without bringing them to the front.
- `winshot_crop` — trim a PNG by pixel rectangle.
- `winshot_mask` — black-out / pixelate / blur one or more rectangles to hide sensitive info.
- `winshot_resize` — scale a PNG (use before sending huge captures to the model).
- `winshot_info` — width × height of a PNG.

## Decision flow

1. **What does the user want?**
   - A specific app/window → `winshot_list_windows` to find the title → `winshot_capture` with `mode=window`.
   - The currently active window → `winshot_capture` with `mode=active`.
   - One physical monitor → `winshot_list_monitors` → `winshot_capture` with `mode=monitor`.
   - A specific screen area but unsure of coordinates → start with `mode=full`, look at the result, then either `winshot_capture` again with `mode=region`, or `winshot_crop` the file you already have.

2. **Coordinate grounding** — every screenshot reply tells you the image's true `WxH`. The pi `Read` tool will tell you the displayed-vs-original scale factor when you re-inspect. Always compute crop coordinates against the **original** image size, never the displayed size.

3. **Re-target if off** — if a region crop misses, re-inspect the parent screenshot, recompute, and re-crop. Don't re-capture the whole screen unless content has changed.

4. **Privacy** — if the user asks to share a screenshot externally (paste into chat, save to repo, etc.), proactively ask whether anything should be masked. Use `winshot_mask` with:
   - `style=black` for hard redaction of secrets (API keys, tokens, emails).
   - `style=pixelate` when the user wants the shape/context but not the content (chat names, faces).
   - `style=blur` for soft aesthetic masking.

5. **Token economy** — for large screenshots (>1600px wide), call `winshot_resize` (e.g. `max_w=1280`) before referencing the image in further reasoning. The capture tools also accept `return_image=false` if you only need the saved path.

## Output paths

- Captures default to `/mnt/c/tmp/pi-winshot/cap_<mode>_<timestamp>.png`.
- Edits default next to the input as `<name>_crop.png`, `<name>_masked.png`, `<name>_resized.png`.
- Tools accept either WSL paths (`/mnt/c/...`) or Windows paths (`C:\...`).

## Limits

- **Minimized windows**: pass `bring_to_front=true` to restore + foreground before capture.
- **DRM-protected video** (Netflix, some DRM players): `PrintWindow` returns a black frame.
- **Hardware-overlay games / Electron edge cases**: if `PrintWindow` produces partial-black output, retry with `bring_to_front=true` (falls back to a true screen grab of the window rect).

## Examples

> "Show me my Chrome window"

1. `winshot_list_windows` → find a row with `Chrome` in the title.
2. `winshot_capture { mode: "window", title: "Chrome" }`.

> "Capture the right half of my main monitor"

1. `winshot_list_monitors` → note `w=2048,h=1152` for monitor 0.
2. `winshot_capture { mode: "region", x: 1024, y: 0, w: 1024, h: 1152 }`.

> "Take the previous screenshot and black out the URL bar around the top"

1. `winshot_info { in: <path> }` → confirm dimensions.
2. `winshot_mask { in: <path>, regions: [{ x: 0, y: 70, w: 2000, h: 80 }], style: "black" }`.

> "That last screenshot is too big, crop just the chat panel"

1. Look at the image, locate the chat panel.
2. `winshot_crop { in: <path>, x: ..., y: ..., w: ..., h: ... }`.
