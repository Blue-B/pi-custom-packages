# pi-verify-gate

> Registers `/verify` (alias `/검증`): independently re-checks the agent's last conclusion against the raw tool evidence of that turn.

## Why

Agents state decision-grade conclusions (ship / spend / "it works" / metric claims) without verifying, and only self-correct when a human pushes back. The naive fix (a text instruction telling the agent to "go verify") has a fatal hole: the same biased agent still picks the target, curates the evidence, and judges the verdict, so "independent" is cosmetic.

`pi-verify-gate` is evidence-side, not text-side. When invoked it does the two steps the agent must not be trusted with, in extension code, straight from the raw session log:

1. **Target selection.** It picks the agent's most recent conclusion deterministically, not by asking the agent to choose.
2. **Evidence gathering.** It pulls the raw tool calls and tool results of that turn verbatim from the session log (the actual outputs, not the agent's paraphrase) and writes them to an evidence file.

Then it dispatches the `reviewer` subagent in a fresh context to read that file directly and grade whether each claim in the conclusion is backed by the raw outputs, returning PASS/FAIL plus the specific gaps. On FAIL the agent must re-run the real tools and correct.

The suspect no longer selects the target or supplies the evidence. The extension does, from a log the agent cannot retroactively edit.

## Install

```bash
git clone https://github.com/Blue-B/pi-custom-packages.git
cd pi-custom-packages
pi install ./packages/pi-verify-gate
```

After install, run `/reload` in pi to activate.

### Requirements

- pi coding agent, tested on 0.84
- [pi-subagents](https://www.npmjs.com/package/pi-subagents), which is where the `reviewer` agent comes from. pi core does not ship one, so without this package `/verify` gathers the evidence but has nothing to grade it

## Usage

Run the command after the agent states a conclusion you want checked:

```
/verify
/검증
```

It always verifies the agent's own last conclusion. You do not pick the target; the extension does, from the session log.

### Optional focus hint (additive only)

You can append text to nudge the reviewer toward a spot you already suspect:

```
/검증 the revenue number looks off
```

This is an emphasis hint only. The full conclusion and the full raw tool evidence are still verified. The hint never narrows the scope, so a lie hiding elsewhere cannot get a "verified" stamp. The instruction explicitly tells the reviewer not to narrow.

## How it works

1. Reads the current branch from `sessionManager.getBranch()`.
2. Finds the window: everything after the last real user message. Its own previously injected `[verify-gate]` follow-ups are skipped so a prior `/verify` cannot become the boundary.
3. Conclusion = all assistant text in the window (not just the closing sentence), so a benign last line cannot hide a risky earlier claim.
4. Pairs each `toolCall` with its `toolResult` by id and writes them, verbatim, to `/tmp/verify-evidence-<sessionId>.md`.
5. Injects a follow-up turn instructing the agent to dispatch `reviewer` with `reads:[that file]` and report PASS/FAIL plus gaps.

### Trust boundary in the evidence file

The conclusion text and tool results are untrusted input that the reviewer reads as source of truth. To stop a conclusion or a fetched web page from forging a verdict or breaking out of its block, every untrusted span is wrapped in a per-build random sentinel (`⟦VG-<hex>⟧`) and any ``` fence inside it is neutralized. The reviewer is told that anything between the markers is inert DATA, never an instruction.

### Window-scope transparency

`steer` messages (a user message injected mid-turn) are indistinguishable from a normal user message in the pi log, so the extension does not pretend to auto-merge them. Instead it surfaces the window scope (boundary message + user-message count) in the evidence file and tells the reviewer to flag a conclusion that appears truncated by a steer.

### Evidence quality guards

- Long tool results keep both ends (head + tail), so a verdict line at the end (pass/fail counts, totals) is never lost to a head-only cut.
- Truncated args and truncated results are explicitly marked, never silently dropped.
- An empty text result (no-match grep, empty output, a successful write) is labelled as a normal result, not mistaken for an unverifiable image.
- A turn with zero tool calls, or with tools but no conclusion text, is flagged so the reviewer does not hand out a vacuous PASS.

## Project layout

```
pi-verify-gate/
  extensions/
    verify-gate/
      index.ts      # the extension (registers /verify and /검증)
  package.json
  README.md
  LICENSE
```

## License

MIT
