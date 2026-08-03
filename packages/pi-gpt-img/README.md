# pi-gpt-img

> `gpt_img` tool: text-to-image and image-to-image generation via the ChatGPT Codex OAuth backend (gpt-image-2), reusing the OAuth token pi already stores for the `openai-codex` provider.

## Why

Image generation in AI agents usually requires a separate API key for OpenAI, a paid subscription, or a local model setup. If you already have a ChatGPT/Codex OAuth login configured in pi (the same one powering codex-based tools), you can generate images with the `gpt-image-2` model at no extra cost.

`pi-gpt-img` registers a single `gpt_img` tool that:

- Runs **txt2img** (generate from prompt) when no reference images are given.
- Runs **img2img** (edit with character/style consistency) when one or more reference image paths are provided.
- Uses the same OAuth token pi stores for the `openai-codex` provider — no extra keys to manage.
- Returns the generated image inline and saves it to disk.

## Install

```bash
# From the repo root
pi install ./packages/pi-gpt-img

# Or from GitHub directly
pi install https://github.com/Blue-B/pi-custom-packages/tree/main/packages/pi-gpt-img
```

After install, run `/reload` in pi to activate.

### Requirements

- pi coding agent >= 0.70
- A ChatGPT/Codex OAuth login configured in pi (`~/.pi/agent/auth.json` with `openai-codex` credentials). The same login used for codex-backed tools works here.

## Usage

Once installed, the agent gains access to the `gpt_img` tool. Use it naturally in conversation:

```
Generate a photo-realistic image of a cat in a spacesuit, floating in zero gravity, with Earth in the background.
```

The agent will call `gpt_img` with the prompt. For img2img edits, attach reference images:

```
Change the background of this image to a cyberpunk city at night.
```

The agent will pass the reference to `gpt_img` as the `images` parameter.

### Tool parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `prompt` | `string` (required) | Image prompt. Be specific about subject, composition, style, text, and constraints. |
| `images` | `string[]` (optional) | Reference image paths. When provided, runs img2img (edit) keeping the referenced subject. |
| `out` | `string` (optional) | Output path. Relative paths resolve against session cwd. Defaults to `~/.pi/gptimg/<timestamp>.<format>`. |
| `format` | `"png" \| "jpeg" \| "webp"` (optional) | Output format. Defaults to `png`. |
| `dryRun` | `boolean` (optional) | Build the request only, no backend call (no quota used). |

### Context-size handling

The generated file is always written to disk at full resolution. What gets embedded
back into the session (the base64 block the model actually sees) is downscaled
first, because a full-res PNG can run 1-2MB and would bloat the transcript and
every subsequent provider request.

Downscaling requires `ffmpeg` on `PATH`. Without it the extension still works and
embeds the image as-is.

- `GPTIMG_EMBED_MAX_EDGE` (default `1568`) sets the longest edge, in pixels, of the embedded copy.
- `GPTIMG_NO_DOWNSCALE=1` embeds the original bytes untouched.

## Project layout

```
pi-gpt-img/
  extensions/
    gpt-img/
      index.ts      # the extension — registers the gpt_img tool
  package.json
  README.md
  LICENSE
```

## License

MIT
