# pi-bash-watchdog

> Guards the bash tool timeout: converts millisecond-style mistakes (120000 to 120s), caps foreground dev-server commands, and fills a sane default so sessions never hang on a stuck command.

## Why

The pi bash tool's timeout unit is **seconds**, but models frequently pass millisecond-style values (e.g. `120000` meaning 120 seconds, which become 33 hours). A foreground server (npm run dev, uvicorn, etc.) passed without `nohup` or `&` will hold the session in "Working…" until the timeout expires, potentially hours. And when no timeout is passed at all, a stuck command hangs the session indefinitely.

`pi-bash-watchdog` hooks every `bash`/`Shell` tool call and:

- **Default fill.** If no timeout is set, applies a configurable default (300s).
- **Millisecond detection.** Values ≥ 10,000 are assumed to be milliseconds and divided by 1000.
- **Hard cap.** Values exceeding the maximum (900s) are clamped.
- **Foreground server cap.** Commands matching common long-running patterns (dev servers, Windows interop, Python servers) are capped at a shorter limit (120s).

It also registers the command `/bash-watchdog-status` so you can inspect the current policy at runtime.

## Install

```bash
git clone https://github.com/Blue-B/pi-custom-packages.git
cd pi-custom-packages
pi install ./packages/pi-bash-watchdog
```

After install, run `/reload` in pi to activate.

### Requirements

- pi coding agent, tested on 0.84

## Usage

Once installed, the watchdog works automatically on every bash tool call. No manual action needed.

### Bypass a single command

Add `pi-watchdog:disable` in the command, or set the env var:

```bash
PI_BASH_WATCHDOG_DISABLE=1 some-command
```

### Check current policy

```
/bash-watchdog-status
```

## Configuration via environment variables

All options are read at extension load time (before starting a pi session). Set them in your shell profile or pi launcher environment.

| Variable | Default | Description |
|----------|---------|-------------|
| `PI_BASH_WATCHDOG_DEFAULT_SEC` | `300` | Timeout in seconds applied when the model passes no timeout. |
| `PI_BASH_WATCHDOG_MAX_SEC` | `900` | Absolute maximum timeout in seconds. Any value above this is clamped. |
| `PI_BASH_WATCHDOG_FOREGROUND_SEC` | `120` | Lower cap for commands identified as foreground long-runners (dev servers, Windows interop, etc.). |
| `PI_BASH_WATCHDOG_NOTIFY` | `"all"` | Notification verbosity: `"all"` – show effective timeout for every bash call (info for benign, warning for corrections). `"corrections"` – quiet unless a ms-style mistake or cap was applied. `"off"` – fully silent. |
| `PI_BASH_WATCHDOG_QUIET=1` | – | Shorthand for `NOTIFY=off`. If set, overrides `PI_BASH_WATCHDOG_NOTIFY`. |

## Commands

| Command | Description |
|---------|-------------|
| `/bash-watchdog-status` | Show current timeout policy (default, max, foreground cap, notify mode). |

## Project layout

```
pi-bash-watchdog/
  extensions/
    bash-watchdog/
      index.ts      # the extension (hooks bash tool calls)
  package.json
  README.md
  LICENSE
```

## License

MIT
