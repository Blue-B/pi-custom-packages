---
name: webgpt-image
description: Generate images through a logged-in ChatGPT web chat in the agent browser, instead of the Codex image endpoint. Use when the user wants web-session image generation, several variations from parallel chats, iterative edits inside one chat thread, or when the Codex image quota is exhausted. Runs unattended in the background; no browser window has to stay in front.
---

# webgpt-image

Drives chatgpt.com like a person: type the prompt into the composer, send it, wait for the image,
then save the downloaded PNG. Same image backend as the `gpt_img` tool (Codex OAuth) — the reason to
use this path is the chat surface, not the pixels.

## Prerequisites

- A browser CLI that exposes `open`, `eval`, `fill`, `click`, `press`, `tab close`.
  Default is `ab` (the WSL wrapper that drives a real Windows Chrome); override with `WG_BROWSER`.
- That browser profile is logged into chatgpt.com. It is persistent, so this is a one-time login.
- Check: `ab open https://chatgpt.com/` then look for `div[contenteditable="true"]`.

## Usage

```bash
S=~/.pi/agent/skills/webgpt-image/scripts   # or the package path

# one chat, one image (ChatGPT decides how many)
$S/gen.sh /tmp/out "prompt"

# the same prompt in 2 chats at once (2 tabs, one browser process)
$S/batch.sh /tmp/out 2 "prompt"
```

Successful runs print the saved PNG paths on stdout; progress and errors go to stderr.
Each job uses its own `AB_SESSION=wg-*` tab and closes it when done.

## Background

```bash
nohup $S/batch.sh /tmp/out 3 "prompt" > /tmp/out.log 2>&1 &
```

The Chrome window may sit behind other windows while this runs. The agent profile is reaped after
an hour of idleness, so do not walk away mid-generation (`tab_gone` means re-run the job).

## Measured (2026-10-23)

- Web chat and `gpt_img` (Codex OAuth) hit the same image backend. The same prompt returned the same
  dimensions on both paths: 1672x941 vs 1672x940 landscape, 1312x1199 portrait-ish on both.
- No model or quality selector exists in the web UI; the server picks size and quality from the prompt.
- Korean text rendering is identical, down to menu prices.
- About 40-90 seconds per image. The footer progress ("마지막으로 살짝 다듬는 중… n%") must finish
  before the file is final.

## Limits

- One chat normally returns one image even when asked for several. For N images run `batch.sh`.
- No transparent background. Use `gpt_img` with `background: transparent` when you need RGBA.
- Consumes the same ChatGPT plan image quota as the Codex path.
- Downloads land in the browser's download folder first; the script copies and deletes them.
- DOM-dependent. If it breaks, check these three first: composer `div[contenteditable="true"]`,
  send button `button[aria-label="보내기"]`, results `img[alt^="생성된 이미지"]`.
