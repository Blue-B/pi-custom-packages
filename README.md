<div align="center">

# pi-custom-packages

**A curated monorepo of extensions for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent).**

Guards that keep long sessions healthy, media tools that give pi eyes and hands,
and quality gates that catch the agent's mistakes before you do.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![pi](https://img.shields.io/badge/pi-%3E%3D%200.70-8A2BE2)](https://github.com/earendil-works/pi-coding-agent)
[![Packages](https://img.shields.io/badge/packages-9-success)]()
[![Node](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)]()

</div>

---

## Packages

### 🛡️ Reliability and guards

Keep sessions from silently breaking: wrong timeouts, schema-invalid tool calls, identity hallucination, unverified conclusions.

| Package | What it does |
|---------|--------------|
| **[pi-verify-gate](./packages/pi-verify-gate)** | Registers `/verify` (alias `/검증`): independently re-checks the agent's last conclusion against the raw tool evidence of that turn, graded PASS/FAIL by a fresh-context reviewer subagent. |
| **[pi-bash-watchdog](./packages/pi-bash-watchdog)** | Guards the bash tool timeout: converts millisecond-style mistakes (`120000` → 120s), caps foreground dev-server commands, fills a sane default. Includes `/bash-watchdog-status`. |
| **[pi-sanitize-tool-call-ids](./packages/pi-sanitize-tool-call-ids)** | Rewrites malformed tool-call IDs to the `[a-zA-Z0-9_-]` subset before every provider request, so cross-provider sessions never fail schema validation. |
| **[pi-model-identity](./packages/pi-model-identity)** | Injects the live model identity as a system reminder on first turn, model switch, and after compaction. The model never hallucinates which model it is. Ships a `model_identity_status` tool. |

### 🧹 Context hygiene

Long image-heavy sessions eat your context window. These keep the outbound provider payload lean without touching the on-disk session.

| Package | What it does |
|---------|--------------|
| **[pi-normalize-images](./packages/pi-normalize-images)** | Downscales and re-encodes every image in the outbound context via ffmpeg (bounded long edge, SHA1 cache, placeholder for undecodable images). |
| **[pi-context-image-cap](https://github.com/Blue-B/pi-context-image-cap)** ↗ | Drops all but the most recent image from the outbound context. Standalone repo; pairs perfectly with pi-normalize-images (cap drops the stale ones, normalize shrinks the survivors). |

### 🎨 Media and input

| Package | What it does |
|---------|--------------|
| **[pi-paster](./packages/pi-paster)** | Turns pasted, drag-dropped, or clipboard-provided image paths into first-class image attachments. |
| **[pi-winshot](./packages/pi-winshot)** | Capture and edit the Windows host screen from a WSL-hosted pi agent: full screen, region, window (even occluded), crop, resize, privacy masking. |
| **[pi-gpt-img](./packages/pi-gpt-img)** | `gpt_img` tool: text-to-image and image-to-image via the ChatGPT Codex OAuth backend (gpt-image-2), reusing the OAuth token pi already stores. |
| **[pi-xai-imagine](./packages/pi-xai-imagine)** | `xai_generate_video` tool: text-to-video and image-to-video via the xAI Grok Imagine API, with OAuth auto-refresh and polling until the MP4 is ready. |

### 🌐 Related standalone repos

Published separately because they are bigger than a single extension:

| Repo | What it does |
|------|--------------|
| **[browser-harness-kit](https://github.com/Blue-B/browser-harness-kit)** ↗ | One-command setup for driving a stealth Chromium (CloakBrowser) from 8+ coding agents, including pi. |
| **[pi-context-image-cap](https://github.com/Blue-B/pi-context-image-cap)** ↗ | Context image capping as a standalone package (see above). |

---

## Install

```bash
# From the repo root, install a specific package
pi install ./packages/pi-verify-gate
pi install ./packages/pi-bash-watchdog

# Or from GitHub directly
pi install https://github.com/Blue-B/pi-custom-packages/tree/main/packages/pi-verify-gate
```

After install, run `/reload` in pi to activate.

Every package is self-contained: install only what you need, nothing depends on the others.

## Requirements

- [pi coding agent](https://github.com/earendil-works/pi-coding-agent) >= 0.70
- Node.js >= 18
- Package-specific extras are listed in each package's README (e.g. ffmpeg for pi-normalize-images, an OAuth login for pi-gpt-img / pi-xai-imagine).

## Why a monorepo?

These extensions are small, share the same conventions, and evolve together with day-to-day pi usage. One repo keeps versioning, issues, and discovery in one place, while each package stays independently installable.

## License

MIT © [Blue-B](https://github.com/Blue-B)
