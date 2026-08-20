# pi-model-identity

> Injects the live model identity (provider/model id) as a system reminder on first turn, on model switch, and after compaction, so a model that takes over a session mid-way does not answer with the previous model's name.

## Why

A model cannot introspect its own weights. It only "knows" its name if something
puts that name in its context, and pi does not: `buildSystemPrompt()` in pi 0.84
takes a cwd, tools, skills and context files, and no model at all.

Some providers fill the gap on their own. Claude Code's binary, which
`pi-claude-bridge` runs behind the scenes, states the model in its own system
prompt, so a Claude session usually gets this right unaided. That injection
never fires for other providers, and more importantly it is written once and
not refreshed. Switch models halfway through a session and the transcript still
carries the old name, which is what the next model reads and repeats.

## Measured

The same session, tested with the extension on and off. First turn asks the
model to identify itself, then the session is handed to a second model and
asked again.

| Extension | First model | Handed to | Second model answered |
|---|---|---|---|
| on | gpt-5.6-sol | claude-opus-5 | `claude-bridge/claude-opus-5` |
| off | gpt-5.6-sol | claude-opus-5 | `gpt-5.6-sol` |
| off | gpt-5.6-sol | grok-4.5 | `grok-4.6` |
| off | claude-opus-5 | gpt-5.6-sol | `gpt-5.6-sol` |

The second row is the failure this exists for: Opus read the earlier turns,
found a model name there, and reported it as its own. The third row is a softer
version, where the model tracked the switch but got the version wrong. The last
row shows it does not break on every handoff, so a single-model session is not
the case to judge this on.

Every turn the extension reads the live model from `ctx.model` and injects a
short system reminder whenever the identity could be stale: the first turn, a
model switch, and the turn after a compaction, since a summary can drop it.

## Install

```bash
git clone https://github.com/Blue-B/pi-custom-packages.git
cd pi-custom-packages
pi install ./packages/pi-model-identity
```

After install, run `/reload` in pi to activate.

### Requirements

- pi coding agent, tested on 0.84

## Usage

No user-facing commands. The extension works automatically:

- On **first turn** of a session, it injects a `<system-reminder>` with the exact model ID.
- On **model switch**, it re-injects so the new model knows its identity.
- After **compaction**, it re-injects since the summary may have dropped the identity.

Disable at any time by setting `MODEL_IDENTITY_DISABLE=1` before starting pi.

### Diagnostic tool

A `model_identity_status` tool is registered and can be called by any model to show the live model identifier, raw id, provider, and last injected identity.

## Project layout

```
pi-model-identity/
  extensions/
    model-identity/
      index.ts      # the extension
  package.json
  README.md
  LICENSE
```

## License

MIT
