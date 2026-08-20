# pi-sanitize-tool-call-ids

> Sanitizes malformed tool-call IDs before every provider request so cross-provider sessions never fail schema validation (rewrites IDs to the `[a-zA-Z0-9_-]` subset).

## Why

Different providers (OpenAI, Anthropic, Google, Grok, xAI, DeepSeek, AWS Bedrock, etc.) enforce different schemas for tool-call IDs. A session that starts on one provider and switches to another frequently fails with `tool_call_id` validation errors because the originating provider emitted an ID containing characters the next provider rejects (`|`, `.`, `:`, spaces, or longer than 64 chars).

Wrapping every trace call in a try-catch or manually cross-referencing ID formats is fragile and gets patched inconsistently across tools. `pi-sanitize-tool-call-ids` intercepts every outbound provider request via the `before_provider_request` hook and normalizes every tool-call ID it finds to the safe `[a-zA-Z0-9_-]` subset. The mapping is stable per session, so IDs survive round-trips even after rewriting.

The sanitizer handles all common provider payload shapes:

- **OpenAI Chat Completions**: `assistant.tool_calls[].id` and `{ role: "tool", tool_call_id }`
- **Anthropic Messages**: `content blocks` with `type: "tool_use", id` and `type: "tool_result", tool_use_id`
- **Nested structures**: recursive walk through arrays and objects for future/dynamic formats

## Install

```bash
git clone https://github.com/Blue-B/pi-custom-packages.git
cd pi-custom-packages
pi install ./packages/pi-sanitize-tool-call-ids
```

After install, run `/reload` in pi to activate.

### Requirements

- pi coding agent, tested on 0.84

## Usage

The extension activates automatically on every provider request once installed. No commands to run.

When a provider rejects a tool-call ID because of invalid characters, the sanitizer has already rewritten it before the request is sent. The new ID is deterministic for the same original ID within a session.

### What gets sanitized

- IDs containing characters outside `[a-zA-Z0-9_-]` → each invalid character is replaced with `_`
- IDs prefixed with another ID separated by `|` (a common cross-provider concatenation artifact) → the prefix is extracted and the suffix discarded before sanitizing
- IDs longer than 64 characters → truncated to 64 chars (no provider supports longer tool IDs)
- Empty IDs after sanitization → replaced with the literal `"tool_call"`

Only IDs in the known schema locations listed above are touched; all other payload fields pass through unchanged.

## Project layout

```
pi-sanitize-tool-call-ids/
  extensions/
    sanitize-tool-call-ids/
      index.ts      # the extension (registers before_provider_request hook)
  package.json
  README.md
  LICENSE
```

## License

MIT
