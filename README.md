# pi-custom-packages

![pi-custom-packages](./assets/banner.png)

Eight small packages for the [pi coding agent](https://github.com/earendil-works/pi), kept in one repo.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![pi](https://img.shields.io/badge/pi-tested%20on%200.84-8A2BE2)](https://github.com/earendil-works/pi)
[![Node](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)](https://nodejs.org)

None of these were planned. Each one started as a session that broke, or a thing
pi could almost do, and the fix turned out small enough to keep around. They live
together because they share conventions and get updated in the same afternoon,
not because they form a system. Take the one you need.

## Install

Seven of the eight, straight from git:

```bash
pi install git:github.com/Blue-B/pi-custom-packages
```

`pi-herdr-subagent-working` is intentionally excluded from that bundle. It
replaces herdr's managed Pi reporter and must be installed separately after the
reporter is disabled, as described in [its README](./packages/pi-herdr-subagent-working).

Or install packages one at a time. Nothing here is on npm, and `pi install` will
not take a subdirectory of a repository, so clone first and install from disk:

```bash
git clone https://github.com/Blue-B/pi-custom-packages.git
cd pi-custom-packages

pi install ./packages/pi-verify-gate
pi install ./packages/pi-winshot
```

Then `/reload` in pi. `pi-remote-pi-space-name` also needs its bundled patch
script and a full Pi restart; its README has the exact command.

No package here imports another, so installing one never drags in the rest. A few
do expect something outside this repo (a subagent, a Windows app, an ffmpeg
binary); those are listed with the package and again under
[Requirements](#requirements).

## Packages

### Guards

Sessions rarely fail loudly. They fail as a wrong timeout unit or a conclusion
nobody checked. These two watch for that.

| Package | What it does |
| --- | --- |
| [pi-verify-gate](./packages/pi-verify-gate) | `/verify` (alias `/검증`) pulls the raw tool calls and results of the agent's last turn straight out of the session log, writes them to a file, and has a fresh-context `reviewer` subagent grade the conclusion against them. The agent never picks the target or supplies the evidence. Needs [pi-subagents](https://www.npmjs.com/package/pi-subagents). |
| [pi-bash-watchdog](./packages/pi-bash-watchdog) | pi's bash timeout is in seconds, and models keep passing milliseconds. Rewrites `120000` to `120`, caps foreground dev servers, fills a default when the field is missing. Adds `/bash-watchdog-status`. |

### Windows desktop

pi runs in WSL and cannot see the Windows desktop directly. `pi-winshot` captures
it through `powershell.exe` over WSL interop, with no Linux-side installation.

| Package | What it does |
| --- | --- |
| [pi-winshot](./packages/pi-winshot) | Capture a screen, a region, a monitor, or one window even when five terminals sit on top of it. Then crop, resize, and mask the parts that should not reach the model. |

### Everything else

| Package | What it does |
| --- | --- |
| [pi-gpt-img](./packages/pi-gpt-img) | A `gpt_img` tool for text-to-image and image-to-image on gpt-image-2, reusing the ChatGPT/Codex OAuth token pi already holds. |
| [pi-herdr-ask-blocked](./packages/pi-herdr-ask-blocked) | [herdr](https://herdr.dev)'s sidebar shows a pane as working the entire time pi is actually waiting on an `ask_user_question` answer. This emits the blocked event herdr's own integration already listens for. |
| [pi-herdr-subagent-working](./packages/pi-herdr-subagent-working) | Keeps a herdr pane working while async `pi-subagents` children are still running. Replaces herdr's managed Pi reporter, so it is installed separately rather than through the root bundle. |
| [pi-remote-pi-space-name](./packages/pi-remote-pi-space-name) | A dozen [herdr](https://herdr.dev) Spaces share one directory, so [remote-pi](https://remote-pi.jacobmoura.work)'s phone tiles all read `shell`, `shell#2`, `shell#3`. Titles each tile with its Space label instead, keeps two Spaces named `~` both called `~`, and renames the tile in place when the Space is renamed. Ships a patch script. |
| [pi-codex-accounts](./packages/pi-codex-accounts) | Codex multi-account: auto-rotates on `429/quota` across `openai-codex` accounts, shows `5h/7d` bars with absolute reset dates (`8/28 05:07`) and current-account highlight. `/codex-accounts` widget hides on close. |

## Platform support

One of the eight needs nothing beyond pi itself: bash-watchdog.
The other seven each want something specific.

| Needs | Packages |
| --- | --- |
| Windows 10/11 with WSL2 and interop | winshot |
| ffmpeg on `PATH` | winshot, gpt-img |
| [pi-subagents](https://www.npmjs.com/package/pi-subagents), for its `reviewer` agent | verify-gate |
| [herdr](https://herdr.dev) with `herdr integration install pi` | herdr-ask-blocked |
| [herdr](https://herdr.dev) and [pi-subagents](https://www.npmjs.com/package/pi-subagents); replaces the managed Pi reporter | herdr-subagent-working |
| [herdr](https://herdr.dev) and [remote-pi](https://www.npmjs.com/package/remote-pi) | remote-pi-space-name |
| A ChatGPT or Codex OAuth login | gpt-img, codex-accounts |

Windows screen capture requires WSL interop; native Linux has no Windows desktop
to capture.

## Requirements

pi, tested on 0.84, and Node.js 18 or newer. Anything else is per package and
listed above; each package README repeats its own.

## Contributing

Issues and pull requests are welcome. These grew out of one person's setup, so a
package that half-works for you is worth reporting: the odds are good that the
broken assumption is mine and not pi's.

## License

MIT © [Blue-B](https://github.com/Blue-B)
