# pi-normalize-images

> Downscales and re-encodes every image in the outbound provider context via ffmpeg (bounded long edge, SHA1 cache, undecodable-image placeholder) without ever touching the on-disk session file.

## Why

Some provider transports (notably openai-codex via ChatGPT OAuth) lack image-aware context management and downscaling. Two failure modes recur when switching away from Claude:

1. **"The image data you provided does not represent a valid image"** — a corrupt / truncated / unsupported screenshot or generated image hard-fails the turn.
2. **Oversized payloads** — full-res screenshots replayed every turn waste context window budget.

`pi-normalize-images` hooks into the `context` event before every LLM call. It re-encodes every image through ffmpeg with a bounded long edge (default 1568px), caches results by SHA1 so the same image is processed once per process, and — crucially — replaces images ffmpeg cannot decode with a text placeholder instead of letting them reach the provider and hard-fail the turn.

The on-disk session JSONL is never modified (the `context` hook clones the message array first). The extension never throws; any failure returns the original image so a paste cannot brick a turn.

## Install

```bash
git clone https://github.com/Blue-B/pi-custom-packages.git
cd pi-custom-packages
pi install ./packages/pi-normalize-images
```

After install, run `/reload` in pi to activate.

### Requirements

- pi coding agent, tested on 0.84
- ffmpeg on `PATH` or at `~/.local/bin/ffmpeg`

## Usage

The extension runs automatically on every LLM call — no command to invoke. It normalizes images silently.

### Configuration (env vars)

| Variable | Default | Description |
|---|---|---|
| `PI_IMG_MAX_EDGE` | `1568` | Long-edge cap in px |
| `PI_IMG_MIN_BYTES` | `81920` (80 KB) | Skip images smaller than this |
| `PI_IMG_QUALITY` | `5` | ffmpeg `-q:v` (lower = better quality) |
| `PI_IMG_NORMALIZE_OFF` | — | Set to `1` to disable entirely |

### Pairing with pi-context-image-cap

`pi-normalize-images` complements [pi-context-image-cap](https://github.com/Blue-B/pi-context-image-cap) which drops stale older images while this one normalizes the survivors. Together they keep the context lean and the images that remain clean.

## Project layout

```
pi-normalize-images/
  extensions/
    normalize-images/
      index.ts      # the extension
  package.json
  README.md
  LICENSE
```

## License

MIT
