# pi-light-eyes

Light-terminal setup for `pi` that does not hurt your eyes. Ships the palette,
the code that writes it into Windows Terminal, and the measurements that
justify each value.

Confirmed good by the user on 2026-09-26 ("지금꺼 딱좋다").

## What it fixes

| Symptom | Cause found by pixel measurement |
|---|---|
| Text looks **bold** | Not Bold. Pure black `#0D0D0D` at 19.4:1 contrast reads as heavier than web text. |
| Background **too white**, eyes hurt | Terminal background was `#FFFFFF` (pure white). |
| Text looks **blurry / stuck together** | ClearType subpixel AA produced 40% color fringing on a light background. |

## The settings

**Windows Terminal** — scheme `ChatGPT Light`, font `D2Coding` 12.5pt normal, `cellHeight` 1.45, `antialiasingMode` grayscale.

| Role | Value | Contrast |
|---|---|---|
| background | `#F2F2F2` | — |
| foreground | `#1A1A1A` | 15.5:1 |
| cursor / selection | `#1A1A1A` / `#B4D5FE` | — |

**pi theme** — `chatgpt-light`, body ink `#1A1A1A`, surface tints one step down
(`userBg #E8EAEE`, `customBg #E6E1F0`, `toolWait #E4E6EA`, `toolOk #D6E6D6`,
`toolErr #F2DAD7`, `selBg #CCD8EE`), export backgrounds `#F2F2F2`.

**herdr** — theme `one-light`, `[ui] host_cursor = "native"` (required for Korean IME; the cell cursor cannot anchor a CJK composition).

## Why these exact numbers

- **`#1A1A1A` not `#0D0D0D`.** Dropping from 19.4:1 to 15.5:1 keeps text crisp while
  removing the "heavy" impression. Still far above the 4.5:1 minimum.
- **`#F2F2F2` not white.** A 4% gray cast removes glare without looking dirty. Measured
  on screen; the whole surface is evenly `#F2F2F2`.
- **`weight: normal`.** Bold ink density 0.258 vs Regular 0.190. At small sizes Bold
  strokes merge (75.2% touching strokes vs 68.7%) — measured on screen, then the
  weight setting turned out to be applied correctly all along.
- **grayscale AA.** ClearType fringing measured 40.1% on a light background, 0% with grayscale.
- **Font size is not monotonic with quality.** 13pt gave 36.2% thin strokes vs 21.7% at
  12.5pt, because of integer pixel snapping. Do not assume bigger is clearer.
- **D2Coding must be registered as separate TTFs.** Registering `D2Coding-all.ttc` alone
  makes Windows unable to distinguish Regular from Bold, so `weight` is ignored.
  `scripts/register-font.ps1` handles this.

## Install (new machine)

### 1. pi theme and skill — via package

```bash
pi install /path/to/pi-light-eyes
```

or add to the `packages` array in `~/.pi/agent/settings.json`:

```json
{ "source": "/path/to/pi-light-eyes", "extensions": [] }
```

Then set the theme in `~/.pi/agent/settings.json`:

```json
{ "theme": "chatgpt-light" }
```

and run `/reload` inside pi.

### 2. Windows Terminal — apply the scheme

From WSL:

```bash
pwsh -File "$(wslpath -w scripts/apply-terminal.ps1)"
```

The script backs up `settings.json` first, then sets the scheme, the font, and
the grayscale AA. It preserves everything else in the file and every other
scheme/profile.

Options:

```powershell
-FontFace 'D2Coding'   # default
-FontSize 12.5         # default
-Bg '#F2F2F2'          # default
-Fg '#1A1A1A'          # default
-DryRun                # print the planned change, write nothing
```

### 3. Font

`assets/fonts/` contains `D2Coding-Regular.ttf` and `D2Coding-Bold.ttf`
(SIL Open Font License 1.1, version 1.3.3 — redistributable).

```bash
pwsh -File "$(wslpath -w scripts/register-font.ps1)"
```

Copies both TTFs into the per-user font directory and registers them as
**separate faces**. This step is what makes `weight: normal` actually work.

### 4. herdr (optional, for Korean input)

In `~/.config/herdr/config.toml`:

```toml
[theme]
name = "one-light"

[ui]
host_cursor = "native"
```

Then `herdr server reload-config`.

### 5. Restart the terminal

Windows Terminal must be restarted for a font or AA change to take effect.
Color and theme changes apply immediately. pi needs `/reload` for theme changes.

## Verify

```bash
pwsh -File "$(wslpath -w scripts/verify.ps1)"
```

Prints the active scheme, font, and AA mode, and checks that both D2Coding
faces are registered separately.

## Rollback

Every script backs up before writing and prints the backup path:

- `settings.json.bak-lighteyes-<timestamp>`
- `settings.json.bak-lighteyes-font-<timestamp>`

Restore by copying the backup back over the original. To undo the theme, set
`theme` in `~/.pi/agent/settings.json` back to `light` or `dark`.

## Gotchas

- **Restart required for font and AA.** Theme and color are live; font and
  antialiasing are read once at process start.
- **Close all terminal windows before replacing the fonts.** A font that is
  loaded by a running process cannot be overwritten. `register-font.ps1` skips
  files whose contents already match and tells you to close the windows when
  they differ.
- **Hot-reload can split one paragraph.** Editing the active theme file while
  output is streaming can render part of a line with the old color
  (observed: left half `#5D5D5D`, right end `#0D0D0D`). Run `/reload` to settle it.
- **Do not use WT's built-in "One Half Light"** with pi's `light` theme — the two
  light backgrounds differ, and widget boxes drawn by extensions look smeared
  against the mismatch.
- **Sarasa Mono K is not usable here.** Its `↑`/`↓` are full-width (1.0em) while pi
  counts them as one cell, so the status line overlaps.

## Files

```text
themes/chatgpt-light.json     pi theme
scripts/apply-terminal.ps1    write scheme + font + AA into WT settings.json
scripts/register-font.ps1     install the two TTF faces into the registry
scripts/verify.ps1            report the active state
skills/light-eyes/SKILL.md    tells pi how to apply this elsewhere
assets/fonts/                 D2Coding Regular + Bold (OFL 1.1)
```

The reference measurements behind every number are in
`skills/light-eyes/reference/measurements.md`.

## Re-running is safe

All three scripts are idempotent. `apply-terminal.ps1` re-run against an
already-configured file produces a byte-identical result, and it only ever
changes the keys listed above; every other scheme, profile, keybinding, and
hand-edited value is preserved. It re-serializes the file, so run it with
`-DryRun` first if you have comments or unusual formatting you care about.

Two implementation traps are worth knowing if you edit these scripts:

- `PSCustomObject` properties must exist before assignment, so new keys go
  through `Add-Member`. A fresh machine's `settings.json` has an empty `schemes`
  array and empty `profiles.defaults`, which is exactly where a direct
  assignment throws.
- PowerShell variable names are case-insensitive. A local `$cellHeight` would
  collide with the `[double]$CellHeight` parameter and silently coerce the
  string `"1.45"` to a number, changing the JSON type on every run.
