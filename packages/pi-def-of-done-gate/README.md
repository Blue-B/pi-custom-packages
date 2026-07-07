# pi-def-of-done-gate

> Runtime definition-of-done guard: tracks code-mutation tool calls vs verification signals per turn and injects a reminder when code changes go unchecked.

## Why

Agents edit code and then report "done" without running any verification, only self-correcting after a human points out the gap. Keeping "verify before done" as prose in AGENTS.md is weak: under context pressure the model nods at the rule and skips it.

`pi-def-of-done-gate` turns the rule into a runtime signal instead of exhortation. It hooks into the agent loop and:

1. **Tracks mutations** — `edit`, `write`, `multiedit`, `ast_grep_replace` tool calls.
2. **Tracks verification** — `lsp_diagnostics` / `lens_diagnostics` calls, bash commands matching test/build/lint/typecheck patterns (`tsc`, `eslint`, `pytest`, `cargo check`, `go test`, `npm run test`, etc.), or a `subagent` call whose input contains `review`.
3. **Warns at turn end** — if code was mutated but nothing verified it, fires a UI notification.
4. **Injects a follow-up reminder** — at the next `before_agent_start` event, a synthetic reminder is inserted telling the agent what files changed and that they should be verified before reporting done.

The extension never rewrites assistant messages. It stays dormant if the `tool_call` event doesn't fire. If a turn touches only config/doc files (non-code extensions like `.json`, `.md`, `.yaml`), no reminder is armed.

## Install

```bash
# From the repo root
pi install ./packages/pi-def-of-done-gate

# Or from GitHub directly
pi install https://github.com/Blue-B/pi-custom-packages/tree/main/packages/pi-def-of-done-gate
```

After install, run `/reload` in pi to activate.

### Requirements

- pi coding agent >= 0.70

## Usage

The extension works automatically after install. No commands need to be called during normal operation.

### Commands

| Command | Description |
|---------|-------------|
| `/def-of-done-status` | Inspect the current ledger state, last evaluation, and whether a reminder is pending for the next turn |

### Disable

```bash
DOD_GATE_DISABLE=1 pi
```

When disabled, only `/def-of-done-status` is registered (showing the gate as disabled).

### What counts as mutation

- `edit` — targeted file edits
- `write` — file creation / overwrite
- `multiedit` — batch edits
- `ast_grep_replace` — structure-aware replace

Only files with code extensions (`ts`, `tsx`, `js`, `jsx`, `mjs`, `cjs`, `py`, `rs`, `go`, `java`, `kt`, `c`, `cc`, `cpp`, `h`, `hpp`, `cs`, `rb`, `php`, `swift`, `scala`, `sh`, `lua`, `vue`, `svelte`, `sql`) trigger the gate. Changes limited to config/doc files are ignored.

### What counts as verification

- `lsp_diagnostics` — LSP diagnostics on a file
- `lens_diagnostics` — pi-lens diagnostics
- `bash` commands matching any of these patterns:
  `tsc`, `tsgo`, `eslint`, `biome`, `ruff`, `mypy`, `pyright`, `pytest`, `vitest`, `jest`, `cargo check` / `cargo test` / `cargo build` / `cargo clippy`, `go test` / `go build` / `go vet`, `npm run test` / `npm run check` / `npm run build` / `npm run lint` / `npm run typecheck` (and pnpm/yarn equivalents), `bash -n`, `node --check`, `make`, `gradle`, `mvn test` / `mvn verify`, `dotnet test` / `dotnet build`
- `subagent` calls whose JSON input contains the word `review` (case-insensitive)

## How it works

1. On `session_start`, the internal ledger is reset.
2. Each `tool_call` is classified as mutation or verification. Mutations increment the counter and record the target file paths. Verification sets a flag.
3. On `agent_end`, if `mutations > 0 && !verified` and at least one mutated file has a code extension, the gate arms a pending reminder and shows a UI warning notification.
4. On `before_agent_start`, if a reminder is pending, a synthetic message (type `def-of-done-gate`, `display: false`) is injected listing how many mutations went unchecked and which files were touched. The agent sees this as context at the start of its next turn.

The content injected is English in published builds of this package (the source may contain Korean developer messages; the package is published with English messages).

## Project layout

```
pi-def-of-done-gate/
  extensions/
    def-of-done-gate/
      index.ts      # the extension (hooks into agent loop)
  package.json
  README.md
  LICENSE
```

## License

MIT
