# pi-remote-pi-space-name

> Titles each [remote-pi](https://remote-pi.jacobmoura.work) mobile tile with the [herdr](https://herdr.dev) Space it belongs to, instead of `shell`, `shell#2`, `shell#3`.

## Why

Open a dozen Spaces in one herdr session and the phone shows a dozen tiles that
are impossible to tell apart. All of them run in the same directory, so they
share one `<cwd>/.pi/remote-pi/config.json` and its single `agent_name`. The
mesh broker keys agents by `(cwd, name)` and disambiguates collisions with
`#2`, `#3`, `#4`, and that suffixed name is what the tile ends up showing.

Renaming a Space did not help either. The tile name is only sent when the room
is announced, so a rename showed up on the phone at the next restart, if at all.

herdr already knows the answer: each pane gets a `HERDR_WORKSPACE_ID`, and the
Space has a label. This package wires that label through to the tile.

## What changes

| What | Before | After |
|---|---|---|
| Tile name | `shell`, `shell#2`, `shell#3` | the Space label |
| Two Spaces both named `~` | `~` and `~#2` | `~` and `~` |
| Spaces with spaces in the label | `앱인토스-아이디어-좁히기` | `앱인토스 아이디어 좁히기` |
| Renaming a Space | nothing until restart | tile renamed in place, same conversation |
| Mesh address | `/home/shell@shell#7` | `/home/shell@<space-label>` |

Out of scope: the dot colour stays remote-pi's own idle/working signal, and
closing a Space still leaves its tile cached as Offline on the phone until you
long-press it.

## How it works

Two halves, because the two problems live in different places.

**The extension** sets `agent_name` from the Space label before remote-pi reads
its config, using `REMOTE_PI_DIRECT_CONFIG`, remote-pi's own documented escape
hatch for supplying the local config inline. The rest of the on-disk config is
preserved, so `auto_start_relay` keeps working. This half needs no patch, and it
is what fixes the mesh address.

**The patch script** covers what only remote-pi can do. The announced room name
and the room id are decided inside remote-pi, so a companion extension cannot
reach them:

- the room name comes from the herdr label rather than the mesh identity, which
  is what lets two Spaces both stay `~`
- the room id is derived from the workspace id rather than `(cwd, name)`, so
  identical labels do not collide and a rename keeps its existing room
- a 5 second poll re-announces the room when the label changes

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

Then **restart** each pi session. `/reload` is not enough: it re-runs the
extensions but keeps the already-loaded remote-pi module.

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
