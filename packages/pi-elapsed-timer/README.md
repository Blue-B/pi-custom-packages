# pi-elapsed-timer

Shows how long pi has been working on the current request. The working row above
the editor updates once a second:

```text
4분 33초 동안 작업 중입니다
```

When the run ends, the normal working message returns and the footer keeps its
total, for example `✓ 4분 33초`.

## Install

From a local clone of this repository:

```bash
pi install ./packages/pi-elapsed-timer
```

Then run `/reload` in pi. The repository's root bundle includes this package too:

```bash
pi install git:github.com/Blue-B/pi-custom-packages
```

If you already use a standalone `~/.pi/agent/extensions/elapsed-timer.ts`, disable
or move that file outside the extensions directory before loading this package.
Do not load both copies: they would update the same working message and footer.

## Timing

Timing starts at `agent_start` and ends at `agent_end`. A queued message is not
counted until pi starts processing it. Tool execution and waits inside that run
are included. This is wall-clock time, not model latency or token-generation time.

Each new run starts at zero. Seconds are rounded down, with minutes shown after
60 seconds. Runs shorter than one second do not replace the footer total.
The interval stops when the run ends or the session shuts down.

No commands, model calls, subprocesses, or saved timing history are added.
Messages stay in Korean, matching the original standalone extension.
Non-interactive runs do not display the timer.

## Requirements and tests

Tested with pi 1.0.0 and Node.js 22.22.2. No additional runtime dependencies.
Uses pi's working-message and footer-status APIs in regular and fullscreen mode.

From this package directory:

```bash
npm test
```

MIT. See [LICENSE](./LICENSE).
