# pi-custom-header

> Replace pi TUI startup header with your own ASCII logo and keybinding hints. Ships as an easy-to-edit template.

## Why

Pi's default startup header shows a block-letter "pi" logo plus a curated set of keybinding hints. That's functional but impersonal—every pi user sees the same branded header.

`pi-custom-header` registers a `session_start` hook that calls `ctx.ui.setHeader()` with your own rendered content. It ships as a **template**: the extension replicates the built-in header exactly out of the box. You are expected to open `extensions/custom-header/index.ts`, edit the ASCII art and hint lines, and `/reload` to see your own header.

No config files, no theme overrides, no build step. Edit the file, reload, done.

## Install

```bash
# From the repo root
pi install ./packages/pi-custom-header

# Or from GitHub directly
pi install https://github.com/Blue-B/pi-custom-packages/tree/main/packages/pi-custom-header
```

After install, run `/reload` in pi to activate.

## Requirements

- pi coding agent >= 0.70
- TUI mode (`pi` with a terminal UI, not `pi --no-tui`)

## Usage

### What the template renders

The extension renders two sections at startup:

1. **Logo** — an ASCII art block followed by the pi app name and version. The template ships with a vertical "pi" pillar logo in box-drawing characters (`█`/`╔`/`╚` etc.), identical to the current built-in header.
2. **Keybinding hints** — a list of keyboard shortcuts (`escape` to interrupt, `ctrl+c` to clear, `/` for commands, `!` for bash, etc.). Each line uses `rawKeyHint()` or `keyHint()` for automatic key-style formatting.

The template currently returns only the logo (the hints are present in the code but commented out) — matching the latest built-in behavior.

### Making it your own

1. Open `extensions/custom-header/index.ts` in your editor.
2. Edit the `ascii_art_2` array inside `buildHeader()` — replace the box-drawing lines with your own ASCII art.
3. Edit the `hints` array — remove, reorder, or add keybinding lines using `rawKeyHint("key", "description")` or `keyHint("editorAction", "description")`.
4. Save and run `/reload` in pi.

Optionally, uncomment `//return \`${logo}\n${hints.join("\n")}\``; and comment out`return logo` to show both the logo and hint lines.

### Restoring the built-in header

The extension also registers the command `/builtin-header`, which clears the custom header and restores pi's default. Run `/builtin-header` and `/reload` to go back to stock.

If you want to remove the extension entirely, delete or rename the installed folder and `/reload`.

## Project layout

```
pi-custom-header/
  extensions/
    custom-header/
      index.ts      # the template — edit this file to customize
  package.json
  README.md
  LICENSE
```

## License

MIT
