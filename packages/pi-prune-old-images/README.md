# pi-prune-old-images

Long sessions that read a lot of screenshots get slow, then crash. Every image a
tool returns is stored inline as base64 in the session file and kept in memory
for the life of the process. Compaction stops sending old images to the model,
but it frees nothing: the file and the heap only grow, and resuming loads it all
again.

This started with a week-long QA session: 975 screenshots, a 603 MB session file,
a 2.2 GB pi process, `sleep 6` taking 80 seconds, and finally a `write ENOBUFS`
crash. After pruning, the same session opened at 163 MB and 0.5 GB.

## What it does

On `session_start` and after every compaction, it finds the latest compaction on
the current branch. Every image block in entries before that compaction's kept
point is replaced with the text `[image removed after compaction]`, in memory and
in the session file. The file is rewritten to a temporary file and renamed over
the original.

Those images are already outside the model context, so what the model sees does
not change. Images after the kept point stay until a later compaction moves past
them. Sessions that never compact are never touched.

## Install

From a local clone of this repository:

```bash
pi install ./packages/pi-prune-old-images
```

Then run `/reload` in pi. It is not part of the root bundle, because it rewrites
session files and should be a deliberate choice.

Also turn off inline image rendering. Drawing hundreds of images into the
transcript is what saturates the terminal and causes the `ENOBUFS` crash, and
pruning only covers the part of the history that compaction has passed:

```json
{ "terminal": { "showImages": false } }
```

Models still receive the images; only the terminal preview is off.

## Things to know

- The removal is permanent. Navigating `/tree` back to a point before the
  compaction shows the placeholder instead of the image. Back up a session file
  first if you might need its old screenshots.
- Only the current branch is pruned. Abandoned branches keep their images.
- It uses `SessionManager` internals (`fileEntries` and the live entry objects)
  that the extension API does not promise. If those disappear in a pi update, it
  does nothing instead of pruning only half.
- If two pi processes hold the same session file open, the one that did not
  prune keeps its own copy in memory until it restarts.

Related upstream issues: [#9613](https://github.com/earendil-works/pi/issues/9613),
[#10642](https://github.com/earendil-works/pi/issues/10642),
[#9549](https://github.com/earendil-works/pi/issues/9549).

## Requirements and tests

Tested with pi 1.4.0 and Node.js 22.22.2. No runtime dependencies.

From this package directory:

```bash
npm test
```

MIT. See [LICENSE](./LICENSE).
