# pi-webgpt-image

Generate images through a logged-in ChatGPT web chat in the agent browser.

`gpt_img` talks to the Codex image endpoint with pi's OAuth token. This package does the same job
through the web UI instead: open chatgpt.com, type the prompt, send it, wait for the image, save the
downloaded PNG. Same image backend, different door.

Reach for it when:

- there is no Codex OAuth token, only a ChatGPT web login;
- you want variations in bulk — `batch.sh` runs several chats at once, one tab each;
- you want to keep editing inside one chat thread, where the conversation context carries over
  (each Codex endpoint request starts from nothing).

Do not expect better images. Measured on the same prompt, both paths returned the same dimensions
(1672x941 vs 1672x940 landscape, 1312x1199 on both for a portrait-ish prompt) and the same Korean
text accuracy. The web UI has no image model or quality selector.

## Install

```bash
git clone https://github.com/Blue-B/pi-custom-packages.git
cd pi-custom-packages
pi install ./packages/pi-webgpt-image
```

Then `/reload` in pi. The skill is `webgpt-image`.

## Requirements

| Need | Detail |
| --- | --- |
| A browser CLI | Defaults to `ab` (the WSL wrapper that drives a real Windows Chrome). Any CLI with `open`, `eval`, `fill`, `click`, `press`, `tab close` works: `WG_BROWSER=agent-browser`. |
| A logged-in ChatGPT profile | Log in once in that browser profile; it persists. Plus or Pro plan, since image generation needs a ChatGPT plan. |
| bash, curl-free | Pure bash + `od`/`find`; no Node, no Python, no API key. |

Downloads are found automatically: `WG_DOWNLOAD_DIR` if set, else the Windows `Downloads` folder
under `/mnt/c/Users/*` (WSL), else `~/Downloads`. On macOS and native Windows only the browser-CLI
and the `AB_SESSION` tab pinning differ, and `WG_BROWSER` plus a small shim covers it.

## Usage

```bash
scripts=./packages/pi-webgpt-image/skills/webgpt-image/scripts

$scripts/gen.sh /tmp/out "prompt"        # one chat
$scripts/batch.sh /tmp/out 3 "prompt"    # three chats in parallel
nohup $scripts/batch.sh /tmp/out 3 "prompt" > /tmp/out.log 2>&1 &   # unattended
```

Saved files print on stdout as `webgpt-<stamp>-<n>.png`. Progress and failures go to stderr; a failed
job exits nonzero so `batch.sh` can report how many of the N chats produced nothing.

## Limits

- One chat usually returns one image even when the prompt asks for several. N images means N chats.
- No transparent background. Use `gpt_img` with `background: transparent` for RGBA cut-outs.
- Shares the ChatGPT plan's image quota with the Codex path.
- The script scrapes the chat UI: composer `div[contenteditable="true"]`, send
  `button[aria-label="보내기"]`, results `img[alt^="생성된 이미지"]`. When ChatGPT ships a new
  composer, those three selectors are the fix.
- The send button label is localized. A non-Korean UI needs that selector adjusted.

## License

MIT © Blue-B
