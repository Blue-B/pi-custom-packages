# pi-tool-scope-optimizer

> Per-turn tool scope management: hides redundant provider shims and heavy media tools on models that do not need them, and restores media tools automatically on turns with media intent (screenshot, image/video generation). Includes `/tools-full` and `/tools-lean` overrides.

## Why

Every model's tool declaration list consumes context window tokens and informs the model's choice. On non-xAI providers (e.g. Claude, Gemini, Grok), the pi runtime exposes tools that are either:

- **Redundant shims** — Cursor/Grok CLI aliases (`Read`, `Write`, `Edit`, `Shell`, ...) that duplicate pi's native tools and add no value outside the Cursor or Grok CLI environment.
- **xAI-native helpers** — tools like `xai_generate_text`, `xai_multi_agent`, `xai_web_search`, `xai_code_execution`, `xai_generate_image`, `xai_critique`, `xai_analyze_image`, `xai_deep_research` that only work when the provider is xai-auth.
- **Heavy/situational media tools** — `winshot_capture`, `winshot_crop`, `winshot_info`, `winshot_list_monitors`, `winshot_list_windows`, `winshot_mask`, `winshot_resize`, `gpt_img`, `xai_generate_video`. These consume significant context budget and are only useful on turns where the user explicitly requests a media operation.

On a normal coding turn, having these tools in the active set wastes tokens, pollutes the model's choice space, and increases the chance of spurious invocations. `pi-tool-scope-optimizer` filters them out automatically on non-xAI models and restores them on demand or when media intent is detected.

## What gets hidden, and when

| Tool set | Hidden when | Condition |
|----------|-------------|----------|
| Cursor shims (`Read`, `Write`, `StrReplace`, `Edit`, `Delete`, `LS`, `Grep`, `Glob`, `Shell`, `WebSearch`) | Always on non-xAI models | provider !== `xai-auth` |
| xAI-native helpers (all `xai_*` except `xai_x_search`) | On non-xAI models | `PI_HIDE_XAI_TOOLS_ON_NON_XAI` (default `1`) != `0` |
| Heavy media tools (`winshot_*`, `gpt_img`, `xai_generate_video`) | On non-xAI models when no media intent detected and not in sticky window | `PI_LEAN_CODING_TOOLS` (default `1`) != `0` |
| Heavy media tools | **Visible** when media intent detected, during sticky window, or when `/tools-full` is active | See below |

All tools are always present in the full set (`pi.getAllTools()`). The optimizer only filters what the model sees via `pi.setActiveTools()` — nothing is unregistered.

### Tool name matching

Because pi can expose tools under an MCP prefix (e.g. `mcp__custom-tools__winshot_capture`), the extension does **suffix-aware matching**: a target like `winshot_capture` matches both the bare name and any `..__winshot_capture` variant.

### context-mode (`ctx_*`) tools

Tools whose bare name starts with `ctx_` (context-mode helpers) are excluded from all filtering — they are never hidden by this optimizer. The extension also seeds its "full set" snapshot with any `ctx_*` tools it finds, so they survive across restores.

## Media-intent detection

The extension inspects the user prompt on every `before_agent_start` event using a regex (`MEDIA_INTENT`) that matches **both English and Korean keywords by design**. The regex is deliberately narrowed (since 2026-06-24) to avoid false positives from ordinary coding conversation:

- **Unambiguous capture/gen keywords** fire standalone: `screenshot`, `screen shot`, `screen capture`, `screencap`, `winshot`, `mask`, `masking`, `blur`, `pixelat`, `mosaic`, `crop`, `generate a( image|video|picture|photo|icon|wallpaper)`, `image gen`, `image generation`.
- **Ambiguous nouns** (`screen`, `image`, `video`, `display`, `monitor`, `화면`, `이미지`, `영상`) require a nearby capture or show verb: the pattern looks for `capture|look at|show me` within 20 characters of `screen|display|window|monitor`, or Korean capture/show verb within 8 characters of `화면`, or a creation verb within 6 characters of `이미지|그림|사진|배경화면|동영상|영상`.

### Sticky window behavior

Once media intent is detected, heavy tools stay visible for a configurable number of **subsequent turns** (default: 3). This prevents a missed keyword on a follow-up like "now crop it" or "그거 잘라줘" from stranding the tool the model just started using. The sticky counter is consumed one per turn and is reset to `STICKY_TURNS` each time media intent re-fires.

Override with env var `PI_MEDIA_STICKY_TURNS` (set to number of turns, default 3).

## Commands

| Command | Description |
|---------|-------------|
| `/tools-full` | Show ALL tools — restore heavy media tools until `/tools-lean`. Useful when a keyword was missed or you want the full toolset for the next few turns. |
| `/tools-lean` | Re-enable lean coding mode — hide heavy media tools on non-media turns. Resets the sticky counter and clears the full-force override. |

## Environment overrides

| Variable | Default | Effect |
|----------|---------|--------|
| `PI_HIDE_XAI_TOOLS_ON_NON_XAI` | `1` | Set to `0` to keep xAI-native tools visible on non-xAI models. |
| `PI_LEAN_CODING_TOOLS` | `1` | Set to `0` to keep heavy media tools always visible (disable lean filtering of media tools). |
| `PI_MEDIA_STICKY_TURNS` | `3` | Number of turns to keep heavy tools visible after media intent is detected. |

## Install

```bash
# From the repo root
pi install ./packages/pi-tool-scope-optimizer

# Or from GitHub directly
pi install https://github.com/Blue-B/pi-custom-packages/tree/main/packages/pi-tool-scope-optimizer
```

After install, run `/reload` in pi to activate.

### Requirements

- pi coding agent >= 0.70

## How it works

1. **On `session_start`** — applies the lean tool set immediately.
2. **On `model_select`** — re-evaluates when the user switches models (e.g. xAI ↔ Claude).
3. **On `before_agent_start`** — checks the user prompt for media intent via regex, and applies the correct tool set before the model responds.
4. **Sticky window** — once media intent fires, a counter (`mediaTurnsLeft`) keeps heavy tools visible for `PI_MEDIA_STICKY_TURNS` subsequent turns, consumed one per `before_agent_start`.
5. **Full set snapshot** — remembers the largest tool set ever observed (including late-registering `ctx_*` tools from MCP bridges) so it always has an accurate restore target.
6. **`/tools-full`** — sets `forceFull = true`, calls `apply` with the unfiltered full set.
7. **`/tools-lean`** — clears `forceFull` and `mediaTurnsLeft`, re-applies lean filtering.
8. **Diagnostic tool** — `toolscope_status` is registered as an inspectable tool that returns the live active tool count, what heavy/shims/ctx tools are visible or hidden, and extension state.

### Trust boundary

No evidence file, no subagent dispatch, no sentinel wrapping — unlike pi-verify-gate, this extension only manipulates tool visibility on the extension API object. All filtering happens synchronously in the event handlers. The `/tools-full` and `/tools-lean` commands use `ctx.ui.notify` for user feedback.

## Project layout

```
pi-tool-scope-optimizer/
  extensions/
    tool-scope-optimizer/
      index.ts      # the extension (registers event hooks, /tools-full, /tools-lean, toolscope_status)
  package.json
  README.md
  LICENSE
```

## License

MIT
