# pi-cap-context-images

> Keeps the most recent image in the outbound provider payload and replaces every older one with a text placeholder, so an image-heavy [pi](https://github.com/earendil-works/pi) session stops growing a request it can never send.

## Why

pi re-sends the whole conversation on every turn. Screenshots and generated images are part of that conversation, so a session with twenty screenshots ships twenty base64 blobs on turn twenty-one, even though nineteen of them were relevant for exactly one turn.

Two things break as a result:

- **Request too big.** The OpenAI/Codex WebSocket transport closes with 1009 once the payload crosses its frame limit.
- **Invalid image data.** Providers reject replayed blocks that were fine the first time.

pi 0.84 does not fix this on its own. Its `images.autoResize` shrinks images as they enter the context (attachments, `read` results, tool results) and `images.blockImages` refuses them outright. Neither one prunes images that are *already* in the context, and there is no setting that caps how many images a request may carry.

## What it does

On `before_provider_request` it walks the outgoing payload, finds every image block, keeps the last one, and rewrites the rest in place into a small text placeholder. The current turn's screenshot still reaches the model, so live visual work is unaffected. Everything older reads as `[older image omitted …]`.

The on-disk session JSONL is never modified: this only rewrites the copy heading to the provider. Start a fresh request and the untouched history is still there.

Schema is preserved per block. OpenAI Responses payloads use `input_image`/`input_text`, Anthropic and chat-style payloads use `image`/`image_url` and `text`, and a neutralized block keeps whichever family it came from.

## Install

```bash
git clone https://github.com/Blue-B/pi-custom-packages.git
cd pi-custom-packages
pi install ./packages/pi-cap-context-images
```

Then run `/reload` in pi.

## Tuning

`KEEP_IMAGES` at the top of the extension controls how many trailing images survive. It ships at `1`. Raise it if you routinely compare two screenshots in one turn; each extra image you keep is another full-size blob on every subsequent request.

## Pairs with

[pi-cap-session-watchdog](../pi-cap-session-watchdog) repairs session files
that already bloated on disk, which this extension deliberately does not touch.
One works on the payload leaving pi, the other on the file already written.

## Bundled script: `patch-image-resize-limit.mjs`

This extension prunes images that are *already* in the context. The bundled
script attacks the same problem one step earlier, at ingest.

pi's `image-resize-core.js` ships `DEFAULT_MAX_BYTES = 4.5MB`, sized against
Anthropic's 5 MB **per-image** limit. The limit that bites first in practice is
the 32 MB **per-request** one: a handful of full-page screenshots at 4.5 MB each
cross it, and the session is then unsendable *and* uncompactable, because image
bytes barely register as tokens so the compactor reports "session too small".

```bash
node ./packages/pi-cap-context-images/scripts/patch-image-resize-limit.mjs
node ./packages/pi-cap-context-images/scripts/patch-image-resize-limit.mjs --check
```

It rewrites the two defaults to 2 MB and JPEG quality 88, and makes both
tunable at runtime through `PI_IMAGE_MAX_MB` and `PI_IMAGE_JPEG_QUALITY`. The
target resolves from `process.execPath`, or pass the file explicitly, or set
`PI_CORE_ROOT`. The original is kept next to it as `.bak-image-limit`.

This edits installed `node_modules`, so a `pi update` reverts it. Re-run the
script afterwards; it is idempotent and a no-op once patched. Note the script
only affects images arriving from now on, it does not shrink a session that
already swallowed oversized ones.

## Requirements

- [pi coding agent](https://github.com/earendil-works/pi), tested on 0.84
- Node.js >= 18

## License

MIT © [Blue-B](https://github.com/Blue-B)
