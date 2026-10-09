---
name: light-eyes
description: Set up or repair a light pi terminal that does not strain the eyes — soft off-white background, grayscale antialiasing, correctly registered D2Coding font, and the chatgpt-light pi theme. Use when the user says text looks too bold, the background is too white or hurts their eyes, glyphs look blurry or stuck together, Korean text misaligns, or when building this environment on a new machine.
---

# light-eyes

Apply a light terminal theme that has been measured, not guessed.

This skill exists because the intuitive fixes are all wrong. Do not reach for
Bold or a heavier font when text "looks bold", and do not simply darken the
foreground. Measure first, then change the one thing that is actually wrong.

## When to use

- "글자가 너무 굵어 보여" / text looks bolder than the web
- "배경이 너무 하얘서 눈이 아파" / background too white, eyes hurt
- Text looks blurry, smeared, or stuck together
- Korean text misaligns or the status line overlaps
- Setting up this environment on a new machine

## The reference configuration

| Where | Setting | Value |
|---|---|---|
| Windows Terminal | scheme | `ChatGPT Light` — bg `#F2F2F2`, fg `#1A1A1A` |
| Windows Terminal | font | `D2Coding` 12.5pt, weight `normal`, cellHeight 1.45 |
| Windows Terminal | antialiasing | `grayscale` |
| pi | theme | `chatgpt-light` (body ink `#1A1A1A`) |
| herdr | theme / IME | `one-light` / `host_cursor = "native"` |

Contrast is 15.5:1. The web-equivalent look is roughly 12–15:1; pure black on
pure white is 19.4:1 and is what makes text feel heavy.

## Procedure

### 1. Measure before changing anything

Do not trust the description of the problem. Capture the window and measure it.

```text
winshot_capture  mode=window  title=<window substring>
```

Then, on the captured PNG, check these three things in order:

1. **Background color** — sample a few empty points across the whole surface.
   A pure `#FFFFFF` is the glare cause.
   Note: a WT window capture includes the tab bar, which is intentionally a
   different gray. Sample the *content area*, below the tabs.
2. **Ink color and stroke width** — take a text line, threshold below 200, and
   compute `ink fraction` and `2 * mean(distance_transform)`. Compare a
   monochrome anti-aliased screenshot against a render of the same string.
   If measured stroke is close to the Regular reference, the font is *not* Bold
   and the problem is contrast or size, not weight.
3. **Subpixel fringing** — look for red/blue edges on glyph sides. Presence means
   ClearType, which fringes badly on light backgrounds.

A working measurement script for step 2:

```python
from PIL import Image
import numpy as np
from scipy import ndimage

g = np.array(Image.open(path).convert("L")).astype(float)
band = g[y0:y1, x0:x1]
m = band < 200
e = ndimage.distance_transform_edt(m)
print("ink", m.mean(), "stroke", 2 * e[m].mean())
```

### 2. Apply the terminal settings

```bash
pwsh -File "$(wslpath -w scripts/apply-terminal.ps1)"
```

Dry-run first if the user's file is heavily customized:

```bash
pwsh -File "$(wslpath -w scripts/apply-terminal.ps1)" -DryRun
```

### 3. Register the font as two faces

```bash
pwsh -File "$(wslpath -w scripts/register-font.ps1)"
```

This is not optional. A combined `D2Coding-all.ttc` registration makes Windows
unable to distinguish Regular from Bold, and the `weight` setting is then
silently ignored.

### 4. Set the pi theme

In `~/.pi/agent/settings.json`:

```json
{ "theme": "chatgpt-light" }
```

Then run `/reload` inside pi. Order matters: set the theme, then reload.
Editing the active theme file while output is streaming can render part of a
paragraph in the old color — reload to settle it.

### 5. Restart Windows Terminal

Font and antialiasing are read once at process start. Theme and color are live.

### 6. Verify

```bash
pwsh -File "$(wslpath -w scripts/verify.ps1)"
```

## Traps that will cost you an hour

| Trap | What actually happens |
|---|---|
| Reaching for Bold or a heavier weight | Makes it worse. Bold strokes merge at small sizes and read as blur, not emphasis. |
| Lowering the font size to fix "bold" | Size and clarity are **not** monotonic. 13pt measured 36.2% thin strokes vs 21.7% at 12.5pt, due to integer pixel snapping. |
| Darkening the foreground | Increases contrast, which is the opposite of what a too-heavy text impression needs. |
| Registering `D2Coding-all.ttc` | Windows cannot separate the faces; `weight` is ignored and you get synthetic bold. |
| Relying on a terminal "restart" without a new process | AA and font changes need a genuinely new process. |
| Using WT's built-in `One Half Light` with pi's `light` theme | The light backgrounds differ, so extension-drawn widget boxes smear against the mismatch. |
| Using Sarasa Mono K | Its `↑`/`↓` are full-width (1.0em) while pi counts one cell, so the status line overlaps. |
| Assuming Korean needs a new font | D2Coding already matches: 1 Hangul = exactly 2 Latin cells (0.500em / 1.000em). Alignment is fine. |
| Judging "bold" from a screenshot at the wrong DPI | Windows Terminal renders at 120 DPI here, so a 12.5pt font is 20.83 device px. Sort out DPI before comparing sizes. |

## Reporting to the user

Lead with the measured cause, not the change. If the user says text is bold and
the measurement shows Regular, say so plainly — the real cause is contrast, and
naming that prevents them from "fixing" it in the wrong place next time.

State the before and after contrast numbers. They are the justification for the
new background color.

## Reference

`reference/measurements.md` holds the raw numbers behind every value here,
including the ones that were tested and rejected.
