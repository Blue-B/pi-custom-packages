# pi-cap-session-watchdog

> On-disk session garbage collector for pi: finds idle oversized session JSONL
> files, caps stale images and trims live context via bundled scripts, with
> cross-process debounce, atomic backups, and backup pruning.

## Why

Long-lived browser sessions accumulate tens of megabytes of stale screenshots
on disk. A live image hook such as [pi-cap-context-images](../pi-cap-context-images)
protects only the outbound wire, dropping stale images from the payload before
it reaches the LLM, and never rewrites the `.jsonl` file. A session that runs
for hours still grows past 70 MB, and every compaction re-reads the inflated
usage metadata, making compaction itself thrash.

`pi-cap-session-watchdog` closes that gap. On `session_start` it sweeps the
sessions root at most once per debounce window across all pi processes
(lockfile + stamp), finds every oversized **and provably idle** `.jsonl` file,
and runs the battle-tested `cap-session-images.mjs` script: backup → temp →
validate → atomic rename, keeps the last N images full, and fixes stale usage
metadata. A second pass (`cap-session-livesize.mjs`) trims sessions whose
**real live context** (last compaction summary + kept messages) has grown past
the model-window ceiling — a trap the disk-size check is blind to.

**Safety guarantees:**

1. Skips any `.jsonl` currently held open by any process (`/proc/<pid>/fd`).
2. Skips any `.jsonl` modified within the last 120 seconds (active window).
3. Capping itself is atomic + backed up by the underlying script.
4. Runs fire-and-forget 2 seconds after session start — never blocks startup.
5. Never throws; all failures are logged to `~/.pi/agent/logs/cap-session-watchdog.log`.

## Install

```bash
git clone https://github.com/Blue-B/pi-custom-packages.git
cd pi-custom-packages
pi install ./packages/pi-cap-session-watchdog
```

After install, run `/reload` in pi to activate.

### Requirements

- pi coding agent, tested on 0.84
- Node.js >= 18

## Usage

Activate by starting a pi session. The watchdog runs automatically — no command
to invoke. Disable with the env var below.

### Environment variables

| Variable                          | Default | Description |
|-----------------------------------|---------|-------------|
| `PI_SESSION_CAP_OFF=1`            | unset   | Disable the watchdog entirely |
| `PI_SESSION_CAP_THRESHOLD_MB`     | `5`     | Size floor (MB) to scan for stale image blocks |
| `PI_SESSION_CAP_KEEP`             | `1`     | Number of most-recent images kept full per session; older ones are capped |
| `PI_SESSION_CAP_MAX_FILES`        | `50`    | Max number of oversized sessions scanned/capped per sweep |
| `PI_SESSION_CAP_BACKUP_DAYS`      | `14`    | Prune `.bak-precap-*` backups older than N days |
| `PI_SESSION_CAP_DEBOUNCE_HOURS`   | `6`     | Minimum hours between sweeps across all processes |
| `PI_SESSION_CAP_INCLUDE_DRVFS=1`  | unset   | Also sweep `/mnt/*` (drvfs/9p) sessions (slow; off by default) |
| `PI_LIVESIZE_MIN_MTIME`           | `600`   | Seconds of idle time before a session is eligible for live-context trimming |

Setting any variable to an empty string or omitting it applies the default.
Set `PI_SESSION_CAP_OFF=1` to disable completely.

## How it works

1. On `session_start`, waits 2 seconds then checks the cross-process throttle
   (lockfile + stamp at `~/.pi/agent/sessions/.cap-sweep.{lock,last}`).
2. If the debounce window has elapsed and no other process is sweeping, it
   prunes stale `.bak-precap-*` backups older than `PI_SESSION_CAP_BACKUP_DAYS`.
3. Scans `/proc/<pid>/fd` for all `.jsonl` files currently held open and marks
   them as protected.
4. Lists every session directory in `~/.pi/agent/sessions/`, finds `.jsonl`
   files that exceed `PI_SESSION_CAP_THRESHOLD_MB` and were last modified more
   than 120 seconds ago. Sorts by size descending, takes the top
   `PI_SESSION_CAP_MAX_FILES`.
5. For each candidate, runs `cap-session-images.mjs` (backup → temp → validate
   → atomic rename, keeps the last `PI_SESSION_CAP_KEEP` images full, fixes
   stale usage metadata).
6. Runs the live-context trim pass (`cap-session-livesize.mjs --all --apply`)
   which independently checks every session's real context size against the
   model-window ceiling. This catches the case where a session has few images
   but its compaction summary + message list has silently grown past the limit.

### Cross-process debounce

Without debounce every `session_start` kicks off a full sweep. With six pi
processes running under six terminal panes, the sweeps pile up 6-deep and
thrash WSL 9p I/O — every TUI keystroke lags. The lockfile + stamp pattern
ensures at most one sweep per `PI_SESSION_CAP_DEBOUNCE_HOURS` across all
processes.

### drvfs/9p exclusion (default)

Reading MB-scale `.jsonl` off the Windows filesystem in WSL costs tens of
seconds per file and starves the TUI's keystroke rendering. Sessions under
`/mnt/*` are skipped by default. Set `PI_SESSION_CAP_INCLUDE_DRVFS=1` to
include them.

## Project layout

```
pi-cap-session-watchdog/
  extensions/
    cap-session-watchdog/
      index.ts              # the extension (registers session_start handler)
  scripts/
    cap-session-images.mjs    # image-capping helper (backup → temp → validate → atomic rename)
    cap-session-livesize.mjs  # live-context-size trim helper (checks real context vs ceiling)
  package.json
  README.md
  LICENSE
```

The extension resolves both scripts package-relative (`./scripts/...`). If the
package is installed via `pi install` and the scripts are not found at the
expected path, the extension falls back to looking in `~/.pi/agent/scripts/`.

## License

MIT
