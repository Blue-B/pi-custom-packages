<div align="center">

# pi-custom-packages

**A curated monorepo of extensions for the [pi coding agent](https://github.com/earendil-works/pi).**

Guards that keep long sessions healthy, media tools that give pi eyes and hands,
and quality gates that catch the agent's mistakes before you do.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![pi](https://img.shields.io/badge/pi-tested%20on%200.84-8A2BE2)](https://github.com/earendil-works/pi)
[![Packages](https://img.shields.io/badge/packages-14-success)]()
[![Node](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)]()

</div>

---

Every package here came out of daily use: something broke, or something was
missing, and the fix was small enough to keep. They are all independently
installable, so take the two you need and ignore the rest.

## Platform support

Most packages run anywhere pi runs. Three of them reach into the Windows host
and therefore need WSL with interop enabled.

| Requirement | Packages |
|---|---|
| Any platform | bash-watchdog, verify-gate, model-identity, sanitize-tool-call-ids, force-websearch-defaults, normalize-images, cap-context-images, cap-session-watchdog, custom-header, gpt-img |
| Windows + WSL | winshot, cursor, recordly |
| [herdr](https://herdr.dev) with the Pi integration installed | herdr-ask-blocked |
| ffmpeg on PATH | normalize-images, gpt-img, winshot |

The three Windows packages shell out to `powershell.exe` through WSL interop.
They need nothing installed on the Linux side, but they do nothing on a native
Linux machine.

## Packages

### 🛡️ Reliability and guards

Keep sessions from silently breaking: wrong timeouts, schema-invalid tool calls, identity hallucination, unverified conclusions.

| Package | What it does |
|---------|--------------|
| **[pi-verify-gate](./packages/pi-verify-gate)** | Registers `/verify` (alias `/검증`): independently re-checks the agent's last conclusion against the raw tool evidence of that turn, graded PASS/FAIL by a fresh-context reviewer subagent. |
| **[pi-bash-watchdog](./packages/pi-bash-watchdog)** | Guards the bash tool timeout: converts millisecond-style mistakes (`120000` → 120s), caps foreground dev-server commands, fills a sane default. Includes `/bash-watchdog-status`. |
| **[pi-sanitize-tool-call-ids](./packages/pi-sanitize-tool-call-ids)** | Rewrites malformed tool-call IDs to the `[a-zA-Z0-9_-]` subset before every provider request, so cross-provider sessions never fail schema validation. |
| **[pi-model-identity](./packages/pi-model-identity)** | Injects the live model identity as a system reminder on first turn, model switch, and after compaction. The model never hallucinates which model it is. Ships a `model_identity_status` tool. |
| **[pi-force-websearch-defaults](./packages/pi-force-websearch-defaults)** | Forces working `web_search` defaults (provider `exa`, workflow `none`) when the model leaves them unset, preventing dead-provider and stale-curator failures. For [pi-web-access](https://www.npmjs.com/package/pi-web-access) users. |

### 🧹 Context hygiene

Long image-heavy sessions eat your context window. These keep the outbound provider payload lean without touching the on-disk session.

| Package | What it does |
|---------|--------------|
| **[pi-normalize-images](./packages/pi-normalize-images)** | Downscales and re-encodes every image in the outbound context via ffmpeg (bounded long edge, SHA1 cache, placeholder for undecodable images). Goes further than pi's built-in `images.autoResize`, which only covers attachments, `read`, and tool results. |
| **[pi-cap-session-watchdog](./packages/pi-cap-session-watchdog)** | On-disk session GC: finds idle oversized session JSONL files, caps stale images and trims live context via bundled scripts, with cross-process debounce and backup pruning. |
| **[pi-cap-context-images](./packages/pi-cap-context-images)** | Keeps only the most recent image in the outbound payload and rewrites older ones as text placeholders. pi's own `images.autoResize` shrinks images on the way in but never prunes what is already in the context. Pairs with pi-normalize-images: cap drops the stale ones, normalize shrinks the survivors. |

### 🎨 Media and input

The Windows three (winshot, cursor, recordly) compose: see the screen, act on it, record the result.

| Package | What it does |
|---------|--------------|
| **[pi-winshot](./packages/pi-winshot)** | Capture and edit the Windows host screen: full screen, region, monitor, or a single window even when it is buried behind other windows. Crop, resize, and mask private regions before the image reaches the model. |
| **[pi-cursor](./packages/pi-cursor)** | Drive the Windows mouse and keyboard: focus a window, move the cursor with natural easing, click, type. Pure PowerShell, no AutoHotkey. |
| **[pi-recordly](./packages/pi-recordly)** | Control the [Recordly](https://recordly.dev) screen recorder: start and stop recordings, target a single window, read status. |
| **[pi-gpt-img](./packages/pi-gpt-img)** | `gpt_img` tool: text-to-image and image-to-image via the ChatGPT Codex OAuth backend (gpt-image-2), reusing the OAuth token pi already stores. |

### 🖥️ TUI

| Package | What it does |
|---------|--------------|
| **[pi-custom-header](./packages/pi-custom-header)** | Replace pi's built-in startup banner with your own ASCII logo and keybinding hints. Ships as an easy-to-edit template. |

### 🔗 Integrations

| Package | What it does |
|---------|--------------|
| **[pi-herdr-ask-blocked](./packages/pi-herdr-ask-blocked)** | Makes [herdr](https://herdr.dev)'s sidebar show a pane as blocked (not working) while pi waits on an `ask_user_question` answer, instead of leaving it stuck on yellow the whole time. Requires herdr with the Pi integration installed. |

---

## Install

These packages are not published to npm, and `pi install` does not accept a
subdirectory of a repository. Clone once, then install the packages you want
from disk:

```bash
git clone https://github.com/Blue-B/pi-custom-packages.git
cd pi-custom-packages
pi install ./packages/pi-verify-gate
pi install ./packages/pi-winshot
```

Run `/reload` in pi afterwards to activate.

Every package is self-contained. Install only what you need; nothing depends on
anything else here.

## Requirements

- [pi coding agent](https://github.com/earendil-works/pi), tested on 0.84
- Node.js >= 18
- Windows 10/11 with WSL2 and interop enabled, for winshot, cursor, and recordly
- ffmpeg on `PATH`, for the three that process images
- An OAuth login for pi-gpt-img (ChatGPT/Codex)
- [herdr](https://herdr.dev) with the Pi integration installed (`herdr integration install pi`), for pi-herdr-ask-blocked

Each package README lists its own extras.

## Why a monorepo

These extensions are small, share the same conventions, and evolve together with
day-to-day pi usage. One repo keeps versioning, issues, and discovery in one
place, while each package stays independently installable.

## Contributing

Issues and pull requests are welcome. These started as personal fixes, so if a
package half-works for your setup, that is worth reporting; the assumptions
baked in are probably mine rather than pi's.

## License

MIT © [Blue-B](https://github.com/Blue-B)
