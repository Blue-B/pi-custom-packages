# pi-skill-indicator

Shows when the agent has a skill active, right in the TUI.

## Problem

Skills are just files the model reads on demand. Nothing in the TUI tells you a skill was triggered mid-conversation, so you can't tell whether the agent is answering normally or running a skill protocol (e.g. a grilling interview).

## What it does

- **Trigger**: the agent reads a skill file via the `read` tool (any `SKILL.md`, any location, any skill name — no hardcoded list).
- **On trigger**: toast notification `🛠️ 스킬 발동: <name>` + persistent footer status `🛠️ <name> 스킬 사용 중`.
- **Turn end**: footer status is cleared automatically.

```
user: 이 계획 그릴해줘
      ┌──────────────────────────────┐
      │ 🛠️ 스킬 발동: grilling         │  ← toast
      └──────────────────────────────┘
❓ Q1 - 목표: ...
[footer] 🛠️ grilling 스킬 사용 중      ← until the turn ends
```

## Install

```sh
pi install git:github.com/Blue-B/pi-custom-packages  # whole monorepo
# or, as a standalone repo/package:
pi install npm:pi-skill-indicator
```

Then `/reload` or restart pi.

## Notes / limitation

Detection is based on the agent reading a `SKILL.md` via the `read` tool. If the agent loads a skill through some other path (e.g. `bash cat`), it is not detected. All standard skill invocations use `read`.

## License

MIT
