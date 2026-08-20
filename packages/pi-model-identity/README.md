# pi-model-identity

> Injects the live model identity (provider/model id) as a system reminder on first turn, on model switch, and after compaction, so the model never hallucinates which model it is.

## Why

An LLM cannot introspect which weights are serving it — it only "knows" its model name if something puts that name into its context. The AGENTS.md identity line has a literal `<model>` placeholder that nothing substitutes, and provider-specific hooks only fire for their own provider. When you switch to a model outside those hooks, no hook fires and the model has zero idea what it is — it may parrot a hardcoded name from the prompt.

`pi-model-identity` is provider-agnostic. Every turn it reads the live model from `ctx.model` and, whenever the identity could be stale (first turn, model switch, after compaction), injects a tiny system-reminder stating the exact running model. Result: switch to any model → that model accurately knows what it is.

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
