# pi-remote-pi-space-name

> Titles each [remote-pi](https://remote-pi.jacobmoura.work) mobile tile with its [herdr](https://herdr.dev) pane, instead of `shell`, `shell#2`, `shell#3`.

## Why

All panes in one herdr session can run in the same directory, so they share one
`<cwd>/.pi/remote-pi/config.json` and its single `agent_name`. The mesh broker
keys agents by `(cwd, name)` and disambiguates collisions with `#2`, `#3`,
`#4`, which is not meaningful on a phone.

Herdr gives every pane `HERDR_WORKSPACE_ID` and `HERDR_PANE_ID`. This package
uses the Space label plus the Herdr pane ID, for example `api · w12:p2`, so
the tile and room are pane-specific. A Space rename updates every live pane in that Space.

## What changes

| What | Before | After |
|---|---|---|
| Tile name | `shell`, `shell#2`, `shell#3` | `Space · wN:pN` |
| Two panes in one Space | one shared room | separate rooms and tiles |
| Same-named Spaces | indistinguishable suffixes | distinct IDs, e.g. `~ · w7Y:p1` |
| Spaces with spaces in the label | `앱인토스-아이디어-좁히기` | `앱인토스 아이디어 좁히기 · w79:p1` |
| Renaming a Space | nothing until restart | each live pane tile renamed immediately |
| Closing a pane or Space | ping timeout | sends `bye` immediately and becomes Offline |

The phone app owns permanent tile deletion. remote-pi has an offline (`bye`)
protocol but no room-delete protocol, so an Offline tile may still need removal
in the app.

## How it works

Two halves, because the two problems live in different places.

**The extension** sets `agent_name` from `Space · workspace · pane` before remote-pi reads
its config, using `REMOTE_PI_DIRECT_CONFIG`, remote-pi's documented inline
config escape hatch. The rest of the on-disk config is preserved, including
`auto_start_relay`.

**The patch script** covers what only remote-pi can do:

- the announced room name comes from the Herdr Space label plus pane ID
- the room id is derived from `HERDR_PANE_ID`, so sibling panes never collide
- one per-pane Herdr socket subscription updates Space renames and stops
  remote-pi when that pane or Space closes, without polling or recurring child
  processes

The patch is idempotent and only rewrites five anchors in `index.js` plus one in
`rooms.js`. If a remote-pi release moves any of them it refuses to apply rather
than half-patching. Outside herdr every injected line is inert.

## Install

```bash
git clone https://github.com/Blue-B/pi-custom-packages.git
cd pi-custom-packages
pi install ./packages/pi-remote-pi-space-name
node ./packages/pi-remote-pi-space-name/scripts/patch-remote-pi-space-name.mjs
```

The script finds remote-pi under `~/.pi/agent/npm/node_modules/remote-pi/dist`
or the global `node_modules`. Pass the directory explicitly, or set
`REMOTE_PI_DIST`, if yours lives elsewhere.

Then **restart** each existing pi session once. `/reload` is not enough for this
one-time install or patch upgrade because it keeps the already-loaded remote-pi
module. After that, Space renames update immediately without restarting or
reloading anything.

```bash
node ./packages/pi-remote-pi-space-name/scripts/patch-remote-pi-space-name.mjs --check
```

`--check` exits 0 when patched, 1 when not. Re-run the script after a
`pi update` or a remote-pi reinstall, since both restore the stock files.

## Reverting

The script writes `index.js.bak-space-name` and `rooms.js.bak-space-name` next
to the originals before its first edit. Restore those two, delete
`herdr-space.js`, and remove the package with `pi remove`.

## Requirements

- [pi coding agent](https://github.com/earendil-works/pi), tested on 0.84
- [remote-pi](https://www.npmjs.com/package/remote-pi), patched against 0.7.0
- [herdr](https://herdr.dev), without which this package does nothing
- Node.js >= 18

## License

MIT © [Blue-B](https://github.com/Blue-B)
