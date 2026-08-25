# pi-herdr-subagent-working

Keeps a Herdr pane in the `working` state while async children launched by `pi-subagents` are still running.

## Why this replaces the official reporter

Herdr's managed Pi integration tracks the parent process through `agent_start` and `agent_settled`. An async child continues in a separate process after the parent settles, so the pane changes to `idle` too early.

A second reporter cannot safely fill that gap. Herdr allows one session owner per pane and keeps a separate monotonic sequence for each source. Reports from `herdr:pi-subagents` are rejected while `herdr:pi` owns the session. Two reporters using `herdr:pi` would instead race with independent sequence clocks.

This package therefore handles both parent and child lifecycle through one `herdr:pi` reporter. The managed `herdr-agent-state.ts` reporter must be disabled while this package is active.

## How it works

The package keeps the official Pi lifecycle behavior, including session identity, blocked state, socket retries, and ordered state reports. Every three seconds it also reads `pi-subagents` run state from `/tmp/pi-subagents-uid-*/async-subagent-runs`.

A child counts as live only when:

- `state` is `running`
- `sessionId` matches the current Pi session file
- `status.json` and `lastActivityAt` were updated within ten minutes

The resulting priority is `blocked`, parent working, async child working, then idle. All reports use the same source and sequence clock.

## Install

```bash
pi install ./packages/pi-herdr-subagent-working
```

Disable the managed reporter by adding this exact exclusion to `~/.pi/agent/settings.json`. Preserve any existing entries in `extensions`.

```json
{
  "extensions": [
    "-extensions/herdr-agent-state.ts"
  ]
}
```

Run `/reload` or restart Pi. The package only activates in a Herdr TUI pane with `HERDR_ENV=1`.

## Uninstall

Remove the package, remove `-extensions/herdr-agent-state.ts` from `extensions`, then reload Pi. This restores Herdr's managed reporter.

## Requirements

- Herdr with the Pi integration installed
- `pi-subagents`
- Pi 0.84 or newer
