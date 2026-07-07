# pi-xai-imagine

> `xai_generate_video` tool: text-to-video and image-to-video via the xAI Grok Imagine API, using the xAI OAuth token pi already stores (with auto-refresh), polling until the MP4 is ready.

## Why

Video generation APIs typically require a separate API key, billing setup, and custom auth plumbing. If you already have an xAI/Grok login active in pi (used by the Grok models themselves), that OAuth token — with its auto-refresh — can also drive the Grok Imagine video endpoint. This tool uses the same `~/.pi/agent/auth.json` credentials pi already manages, so no API key is needed.

It handles the full lifecycle:

1. **Auth resolution** — reads the `xai-auth` token from the pi auth file, refreshing via `refresh_token` when near expiry, and writes the new token back so concurrent consumers benefit.
2. **Submission** — POSTs to the confirmed `/v1/videos/generations` endpoint (the plural route, not the documented one that 404s).
3. **Polling** — checks `/v1/videos/{request_id}` every 5 s until `status: "done"`, surfacing progress to the agent.
4. **Download** — saves the resulting MP4 to a local path (default `~/.pi/xai-video/<timestamp>.mp4`) and returns both the saved path and the hosted URL.

## Install

```bash
# From the repo root
pi install ./packages/pi-xai-imagine

# Or from GitHub directly
pi install https://github.com/Blue-B/pi-custom-packages/tree/main/packages/pi-xai-imagine
```

After install, run `/reload` in pi to activate.

### Requirements

- pi coding agent >= 0.70
- An xAI/Grok OAuth login in pi (`~/.pi/agent/auth.json`). The same login you use to chat with Grok models. If you haven't logged in yet, open pi and authenticate with an xAI/Grok provider.

## Usage

Once installed and activated, the tool `xai_generate_video` becomes available to the agent. The model will call it automatically when you ask for a video. Parameters:

| Parameter | Type | Description |
|-----------|------|-------------|
| `prompt` | string (required) | Description of the video / motion to generate |
| `image` | string (optional) | Source image for image-to-video: https URL, local path, or data URI |
| `model` | string (optional) | `grok-imagine-video` (default) or `grok-imagine-video-1.5-preview` |
| `duration` | number (optional) | Clip length in seconds. Default 6 |
| `aspect_ratio` | string (optional) | `16:9` (default), `9:16`, or `1:1` |
| `resolution` | string (optional) | `480p`, `720p` (default), or `1080p` |
| `out` | string (optional) | Where to save the .mp4. Defaults to `~/.pi/xai-video/<timestamp>.mp4` |

### Notes

- `grok-imagine-video-1.5-preview` requires an `image` parameter (image-input only).
- Video generation is a paid service (~$0.50/s). The agent will warn before calling it.
- Polling runs for up to ~10 minutes before timing out.

## How it works

1. `resolveXaiToken()` loads `~/.pi/agent/auth.json`, extracts the `xai-auth` entry, refreshes via OAuth if the token is near expiry, and persists the updated token back to disk.
2. `buildImageField()` converts the `image` parameter into the API's `{ url }` shape — passing through public HTTPS URLs and data URIs directly, or reading local files and encoding them as inline data URIs.
3. The tool POSTs to `https://api.x.ai/v1/videos/generations` with `model`, `prompt`, `image` (if any), `duration`, `aspect_ratio`, and `resolution`.
4. It polls `https://api.x.ai/v1/videos/{request_id}` every 5 seconds, emitting status updates.
5. When `status: "done"`, it downloads the MP4, writes it to the output path, and returns the saved path + hosted URL.

## Project layout

```
pi-xai-imagine/
  extensions/
    xai-imagine/
      index.ts      # the extension (registers xai_generate_video tool)
  package.json
  README.md
  LICENSE
```

## License

MIT
