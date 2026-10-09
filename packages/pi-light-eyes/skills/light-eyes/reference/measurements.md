# Measurements behind the light-eyes configuration

All values measured on 2026-09-26 in this environment.

Host: Windows 11 at 120 DPI, single 2048x1152 display, inside WSL2.
Capture: PrintWindow via `pi-winshot`. Analysis: PIL + numpy + scipy.

## Contrast table

Text color against each candidate background, computed with the WCAG relative
luminance formula. This is the basis for `#F2F2F2` + `#1A1A1A`.

| background | #0D0D0D | #1A1A1A | #262626 | #333333 |
|---|---|---|---|---|
| `#FFFFFF` | 19.4 | 17.4 | 15.1 | 12.6 |
| `#FDFDFC` | 19.1 | 17.1 | 14.9 | 12.4 |
| `#FAFAF8` | 18.6 | 16.7 | 14.5 | 12.1 |
| `#F7F7F5` | 18.1 | 16.2 | 14.1 | 11.8 |
| `#F5F4F1` | 17.7 | 15.8 | 13.8 | 11.5 |
| **`#F2F2F2`** | 17.4 | **15.5** | 13.5 | 11.3 |
| `#EFEFEC` | 16.9 | 15.1 | 13.1 | 11.0 |

Chosen: `#F2F2F2` at 15.5:1. Pure white was the glare source; `#0D0D0D` on it
produced the "too bold" impression.

The "web looks lighter" reference point: typical web body text sits near
12–15:1, not 19:1.

## Is the font Bold?

The user reported text looked bold. Measured on a body line, using
`2 * mean(distance transform)` inside thresholded glyphs as the stroke estimate.

| Source | stroke (px) | ink fraction |
|---|---|---|
| On-screen body text | 2.06–2.31 | 0.15–0.29 |
| D2Coding Regular reference | 2.25 | 0.170 |
| D2Coding Bold reference | 2.77 | 0.213 |

Conclusion: the screen matched **Regular**, not Bold. `weight: normal` was
already applied and working. The "bold" impression came from contrast, not from
the font face.

The font tables confirm the two faces are distinct and correctly tagged:

| Face | usWeightClass | macStyle | panose.bWeight | isFixedPitch |
|---|---|---|---|---|
| Regular | 400 | 0 | 6 | 1 |
| Bold | 700 | 1 | 6 | 1 |

## Font size is not monotonic with clarity

Stroke thickness measured for the same string at different point sizes. Smaller
point sizes snapped to integer pixels and produced *thicker* apparent strokes in
this range.

| Size | stroke | thin strokes |
|---|---|---|
| 11.5pt | 2.15 | — |
| 12.0pt | 2.28 | — |
| **12.5pt** | **2.28** | **21.7%** |
| 13.0pt | 2.35 | 36.2% |

12.5pt chosen. 13pt was measurably worse, not better.

Rejected but viable alternatives, for a lighter feel:

| Variant | glyph height | stroke index | note |
|---|---|---|---|
| 12.5pt / `#1A1A1A` | 22 | 0.105 | current |
| 12.0pt / `#262626` | 19 | 0.113 | smaller, close |
| 11.5pt / `#1A1A1A` | 18 | 0.122 | lightest tested |

## Bold face ink density (why Bold must be avoided)

| Face | ink density | touching strokes |
|---|---|---|
| Regular | 0.190–0.214 | 68.7% |
| Bold | 0.258–0.274 | 75.2% |

At 20px em width the stroke diameter was 2.06 (Regular) vs 2.32 (Bold). Bold
strokes merge at this size, which reads as blur rather than emphasis.

## Korean alignment

D2Coding advance widths:

| Glyph | em width | cells |
|---|---|---|
| Latin (`a`, `l`, `7`) | 0.500 em | 1 |
| Hangul (`가`, `를`) | 1.000 em | 2 |

Exactly 2:1. This is why D2Coding aligns correctly and why non-monospaced Korean
fonts (Malgun 1.09:1, Noto Sans KR 1.19:1, Gulim 1.23:1) do not.

## D2Coding vs other Korean fonts, at matched glyph height

Ink mass per glyph height — lower is lighter. D2Coding Regular is the heaviest of
the candidates, which compounds the contrast impression.

| Font | glyph height | ink mass / height |
|---|---|---|
| Noto Sans KR | 15 | 41.95 |
| Malgun Light | 15 | 46.55 |
| Malgun | 15 | 54.54 |
| NanumGothic | 15 | 55.85 |
| **D2Coding Regular** | 16 | **57.87** |
| D2Coding Bold | 15 | 75.44 |

Kept D2Coding for the 2:1 Hangul alignment; compensated with contrast instead.

## Subpixel fringing

ClearType on a white background produced visible red/blue edges on glyph sides
(measured 40.1% of edge pixels). `antialiasingMode: grayscale` reduced this to 0%.

## Traps discovered empirically

- **A window capture includes the tab bar.** Sampling "background" from the top
  of a captured window returns the tab row color (`#E8E8E8`), not the content
  background. Sample below the tabs.
- **Hot-reload can split one paragraph.** After editing the active theme file
  mid-stream, a single line rendered with the left half at `#5D5D5D` and the
  right end at `#0D0D0D`. Values confirmed by pixel counts: 2958 px of `#5D5D5D`
  vs 1859 px of `#0D0D0D` on one line. `/reload` fixes it.
- **Sarasa Mono K arrows are full-width.** `↑`/`↓` measure 1.0em while pi counts
  one cell, so `↑264k ↓28` in the status line overlaps.
- **A `D2Coding-all.ttc` registration breaks weight selection.** Windows then
  cannot distinguish the faces. Register `D2Coding-Regular.ttf` and
  `D2Coding-Bold.ttf` separately, by full path.

## Rejected approaches

| Approach | Why rejected |
|---|---|
| Catppuccin Latte palette | 7.06:1 contrast measured as visibly blurry at this size. |
| Custom palette with a beige cast (`#f4f1ea`) | Read as flesh-toned/skin-colored. Use neutral gray. |
| Bold weight | Measured worse (see above). |
| 13pt for clarity | Measured worse (see above). |
| WT built-in `One Half Light` with pi `light` theme | Background mismatch smears extension-drawn widget boxes. |
| Sarasa Mono K | Full-width arrows break the status line. |
