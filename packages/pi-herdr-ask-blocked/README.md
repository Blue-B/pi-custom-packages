# pi-herdr-ask-blocked

> Makes [herdr](https://herdr.dev)'s sidebar show a pane as **blocked** (not **working**) while [pi](https://github.com/earendil-works/pi) is waiting on an `ask_user_question` answer.

## Why

herdr's official Pi integration only tracks `agent_start`/`agent_settled`, so a pane sits on yellow "working" the entire time pi is actually stuck waiting for you to answer a question — indistinguishable from normal busy work until you click in and look. The integration's own code already has a `blocked` state and already listens for a `herdr:blocked` event; nothing was ever emitting it for `ask_user_question`. This package fires that missing event.

Tracked upstream, unresolved as of 2026-08-20: [herdrdev/herdr Discussion #1346](https://github.com/herdrdev/herdr/discussions/1346). Once herdr ships this natively, this package becomes unnecessary.

## How it works

1. pi loads every `.ts` file under `~/.pi/agent/extensions/`, including this one and herdr's own `herdr-agent-state.ts` (which herdr writes there when you run `herdr integration install pi`).
2. This extension watches for `tool_execution_start`/`tool_execution_end` on any tool named `ask_user_question` and emits `pi.events.emit("herdr:blocked", { active, label })` — an in-process event, nothing sent over the network.
3. herdr's own `herdr-agent-state.ts`, loaded in the same pi process, already listens for that event and does the real work: it writes the `pane.report_agent` state over herdr's Unix socket, which is what actually repaints the sidebar.

This package never talks to herdr directly. It only bridges an event that herdr's own integration is already listening for.

## Install

```bash
git clone https://github.com/Blue-B/pi-custom-packages.git
cd pi-custom-packages
pi install ./packages/pi-herdr-ask-blocked
```

Then run `/reload` in pi (or restart the session) to activate.

## Requirements

- [pi coding agent](https://github.com/earendil-works/pi), tested on 0.84
- [herdr](https://herdr.dev) with the Pi integration installed (`herdr integration install pi`) — without it, this package has nothing to bridge to and does nothing
- Node.js >= 18

## License

MIT © [Blue-B](https://github.com/Blue-B)
