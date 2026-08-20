# pi-force-websearch-defaults

> Forces sane `web_search` tool defaults (`provider`, `workflow`) when the model leaves them unset or on `auto`, preventing dead-provider and stale-curator failures. Built for pi-web-access users.

## Why

In some environments `web_search` only works reliably with a specific configuration:

- **`workflow`** — The default (`summary-review`) opens an interactive curator that goes stale and returns `"Search curation cancelled (stale)"`. Setting `workflow: "none"` skips the curator and returns raw results directly.
- **`provider`** — The default (`auto`) can fall through to dead or blocked providers (Perplexity, xAI with no key, Gemini behind a network block). Pinning `provider: "exa"` routes every search to the only provider guaranteed to have a valid key.

This rule is conventionally documented in AGENTS.md, but that is only *probabilistic* guidance — the model keeps forgetting and hitting the stale-cancel. `pi-force-websearch-defaults` makes the fix **deterministic**: extension code fires before every `web_search` tool call, fills in the safe defaults, and every other tool passes through untouched.

## Install

```bash
git clone https://github.com/Blue-B/pi-custom-packages.git
cd pi-custom-packages
pi install ./packages/pi-force-websearch-defaults
```

After install, run `/reload` in pi to activate.

## What it forces

| Parameter | Forced value | When applied |
|-----------|--------------|-------------|
| `workflow` | `"none"` | When `undefined` or `null` (model didn't choose one) |
| `provider` | `"exa"` | When `undefined`, `null`, or `"auto"` |

### Conditions

- Only applies to the `web_search` tool (including MCP-gateway variants like `mcp__oc__web_search` or `<namespace>.web_search`).
- Only fills fields that are absent or set to the broken default — any explicit model choice is preserved.
- All other tool calls are pure pass-through with zero side effects.
- No environment variable overrides exist in the extension code.

### Revert

Delete `extensions/force-websearch-defaults.ts` and run `/reload` in pi (or start a new session).

## Requirements

- pi coding agent, tested on 0.84
- The [`pi-web-access`](https://github.com/nicobailon/pi-web-access) package (npm `pi-web-access`) providing the `web_search` tool

## Project layout

```
pi-force-websearch-defaults/
  extensions/
    force-websearch-defaults.ts   # the extension (listens for tool_call events)
  package.json
  README.md
  LICENSE
```

## License

MIT
