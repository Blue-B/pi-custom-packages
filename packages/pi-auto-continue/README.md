# pi-auto-continue

Auto-resume for [pi](https://github.com/earendil-works/pi) coding-agent turns killed by transient provider errors.

pi retries dropped streams mid-turn (`settings.retry`, default 3 attempts). When that budget runs out, the turn dies with something like `Retry failed after 3 attempts: Provider finish_reason: network_error` — and you get to type "continue" by hand. This extension queues that same continuation automatically.

## Behavior

- Triggers only on transient transport failures: dropped/ended streams, timeouts, overloads, rate limits, HTTP 429/5xx, `finish_reason: network_error`.
- Never triggers on auth/quota/context-overflow/content-filter errors.
- Sends a follow-up message telling the model to continue from where it stopped, without redoing finished work.
- Caps consecutive auto-resumes (default 3). Any successful turn resets the counter.

Upstream pi deliberately leaves resume manual (see earendil-works/pi#7609); this fills that gap for flaky/free providers.

## Configuration

| Env | Default | Meaning |
| --- | --- | --- |
| `PI_AUTO_CONTINUE_MAX` | `3` | Max consecutive auto-resumes before giving up |
| `PI_AUTO_CONTINUE_PROMPT` | English "continue from where it stopped" | The follow-up message sent on resume |
| `PI_AUTO_CONTINUE_DEBUG` | unset | Set to `1` to log settle decisions to `/tmp/pi-auto-continue.log` |

## Install

Option A — clone and register:

```bash
git clone https://github.com/Blue-B/pi-custom-packages.git
```

```jsonc
// ~/.pi/agent/settings.json
{
  "packages": ["<path-to>/pi-custom-packages/packages/pi-auto-continue"]
}
```

Option B — single file: copy `extensions/auto-continue.ts` into `~/.pi/agent/extensions/`. pi auto-loads that directory.

Restart pi afterwards.

## License

MIT
