# pi-herdr-subagent-working

> Keeps [herdr](https://herdr.dev)'s sidebar showing a pane as **working** while an async subagent child launched by that [pi](https://github.com/earendil-works/pi) session is still running.

## Why

When pi launches a subagent in async/background mode, the child runs in a separate headless process. herdr's official Pi integration (`herdr-agent-state.ts`, installed by `herdr integration install pi`) only tracks the parent process's `agent_start` / `agent_settled` lifecycle, so:

1. The parent turn ends right after launching the child, and the pane flips to idle/done.
2. The token counters freeze at their last value even though work continues.

The pane looks finished for many minutes until the child's completion wakes the parent. This package closes that gap: it polls the async run state that `pi-subagents` already writes under `/tmp/pi-subagents-uid-*/async-subagent-runs/*/status.json`, and reports **working** to herdr over the same Unix socket the official integration uses, with a label like `서브에이전트 실행 중`. When the last child finishes, it releases control again.

## How it works

1. On each poll (every 3s), read the run directories owned by this user and count entries whose `status.json` says `state: "running"` **and** whose `sessionId` equals this session's own session file, and whose writer was active within the last 10 minutes (crashed writers are ignored).
2. While the count is above zero, report `pane.report_agent` state `working` to herdr, re-asserting every 15 seconds so a racing report from the parent lifecycle cannot leave the pane stuck on idle.
3. When the count drops back to zero and the parent itself is idle, report `idle` once and call `pane.clear_agent_authority` to hand control back to the official integration.

Two deliberate design choices, both driven by herdr's server internals (`src/terminal/state.rs`):

- **Separate source id** (`herdr:pi-subagents`). herdr keeps per-source monotonic sequence numbers and silently rejects older ones. Reporting on the official `herdr:pi` source would poison the integration's future updates forever.
- **No session claim** on our reports, so herdr's session-owner conflict checks stay untouched.

This package never talks to herdr directly beyond those socket messages; everything else remains the official integration's job.

## Install

```bash
git clone https://github.com/Blue-B/pi-custom-packages.git
cd pi-custom-packages
pi install ./packages/pi-herdr-subagent-working
```

Then run `/reload` in pi (or restart the session) to activate. Requires running inside herdr (`HERDR_ENV=1`; otherwise the extension does nothing).

## Requirements

- herdr with the official Pi integration installed
- [pi-subagents](https://www.npmjs.com/package/pi-subagents) (it owns the run directory format this polls)

## Notes

- Foreground subagents need no help: the tool call blocks the turn, so the pane stays working anyway.
- Once herdr tracks background subagent lifecycles natively (see upstream [#2354](https://github.com/herdrdev/herdr/issues/2354) and [#3052](https://github.com/herdrdev/herdr/issues/3052) for the same bug class in other agents), this package becomes unnecessary.
