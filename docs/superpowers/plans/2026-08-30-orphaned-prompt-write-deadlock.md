# Recovering from an orphaned prompt write

> Fixes #679

## Outcome

A prompt delivery that writes bytes into Claude's composer but cannot send Enter
must no longer deadlock the session. Today it does, permanently, and the only
escape is for the user to know they can press Ctrl+U in the raw terminal.

## The deadlock

Three individually-correct decisions compose into a trap.

**1. Delivery abandons bytes in place, by design.**
`deliverClaudePrompt` writes the body, then waits up to `CONFIRM_TIMEOUT_MS`
(2s) to *see* it absorbed. On timeout:

```ts
return failure({
  stage: 'absorption', code: 'absorption-timeout', retrySafe: false,
  disposition: 'do-not-retry',
  promptWritten: true, enterWritten: false,
  ...
})
```

with the comment: *"Prompt bytes are already editable in Claude even when our
detector times out. Automatic retry is unsafe: it would append/duplicate those
bytes."* That reasoning is right — retrying would duplicate. But **nothing then
clears them**, and no composer-clearing code path exists anywhere in the repo.

**2. The gate correctly reads those bytes as a draft.**
`parseClaudeComposerState` sees real characters and returns `drafted`. It is not
malfunctioning; the composer genuinely contains text.

**3. The gate deliberately never times out.**
`derivePromptGateState` returns `{ kind: 'occupied', reason: 'human-draft' }`,
and its comment records that a 10s staleness bound was tried and **removed**
because it expired mid-sentence and let an agent type over a human's draft:
*"any purely temporal escape hatch trades a recoverable stall for unrecoverable
data loss."*

So the system writes bytes it cannot confirm, abandons them by design, then
treats its own abandoned bytes as a human draft it must never overwrite — with
no exit. **The "human" is Agent Code.**

Evidence (`incidents/runs/*/events.jsonl`): 10 orphaned writes recorded;
`not-ready` is the most common submit failure at 57; 833 of 2,319 `gate.eval`
verdicts are `occupied/human-draft`; 56 lasted >60s, 24 >300s, longest 47h; and
**19 of 216 sessions ended still occupied**.

## What this must NOT do

- **Must not reintroduce a timeout on the gate.** That was tried and it destroys
  user input. This plan does not touch the temporal behaviour at all.
- **Must not clear a composer that holds a human's text.** The gate exists to
  protect exactly that, and a fix that trades a stall for lost typing is worse
  than the bug.
- **Must not auto-retry the delivery.** Duplicate submission is the failure the
  `do-not-retry` disposition was chosen to prevent.

## Design

### Stage 0 — Read the composer's text

There is no way today to ask "what is in the composer" — only
`empty | drafted | unpainted`. Every safe version of this fix needs the content,
because the only sound licence to clear is *"these are provably the bytes we
wrote"*.

`ScreenParser` already locates the composer box and its marker row; extracting
the text between marker and lower rule is a small addition beside
`parseClaudeComposerState`, reusing the same box search so the two can never
disagree about which rows they describe.

### Stage 1 — Record the orphan on the session

When delivery returns `promptWritten && !enterWritten`, the session records
`{ at, text }` for what it believes it left behind. This is the difference
between "someone typed" and "we failed halfway", which is precisely the
distinction the gate cannot currently make.

### Stage 2 — A distinct, recoverable gate state

`derivePromptGateState` gains a branch **before** `human-draft`: composer is
`drafted`, an orphan is recorded, and the composer's current text still equals
the orphaned text → `{ kind: 'occupied', reason: 'stale-write' }`.

Blocking behaviour is unchanged — it still refuses delivery. The point is that
the state is now *nameable and recoverable*, where `human-draft` is a dead end.

If the text has *diverged* — the human typed after our orphan — it falls through
to `human-draft` and stays blocked. That is the safety property: **we only ever
claim bytes we can prove are ours.**

### Stage 3 — Recover on the next explicit send

When a new delivery begins and readiness reports `stale-write`, delivery clears
the composer, drops the orphan record, re-evaluates readiness once, and proceeds.

**Why clear here and not at the moment of failure:** clearing at failure time
destroys the prompt while the user is still looking at it, with no signal. At
the *next* send the user (or an agent) is explicitly asking to submit something
new, which is consent-by-action that the stale content is unwanted. It also
means a session that is never used again is never mutated.

**Why the clear must be verified, not assumed:** `Ctrl+U` (`\x15`) is a real
kill key upstream (`useTextInput.ts:417` — `isKillKey` handles ctrl+k/u/w), but
it is readline kill-to-line-start, so a multi-line orphan may need more than one.
The implementation must confirm the composer actually reached `empty` before
continuing, and fail loudly rather than writing a new prompt on top of a
partially-cleared one — that would produce exactly the mangled submission this
whole subsystem exists to prevent.

### Stage 4 — Make the state visible

`readiness.ts` maps every non-ready verdict to `'waiting for agent'`, and
`session-runtime/state.ts` records that the detailed verdict is collapsed to
`provider-not-ready` before leaving main. Both flag it as a known deliberate
gap. It is why this bug needed a journal dig to identify: a latched gate and a
slow boot look identical.

Widening `SessionInputReadiness` is Tier-3 transport. If it proves larger than
the fix itself it ships separately, but the bug is materially harder to diagnose
without it and the issue lists it as an acceptance criterion.

## Testing

Recorded-data first, per the repo's convention:

1. **The deadlock itself.** Drive `deliverClaudePrompt` to an absorption timeout,
   then attempt a second delivery, and assert it is *not* refused forever. This
   is the regression; it must fail against `main`.
2. **Orphan text divergence keeps blocking.** Orphan recorded, but the composer
   text has changed → gate stays `human-draft`, nothing is cleared. This is the
   safety property and the one most likely to be broken by a later "simplifying"
   refactor.
3. **No orphan record → unchanged behaviour.** A genuine human draft with no
   orphan still blocks. Guards against the fix widening into "clear whenever
   blocked".
4. **Partial clear does not proceed.** If the composer is still non-empty after
   the clear, delivery fails rather than writing on top.
5. **Composer text extraction** against real captured screens from
   `session-recordings`, including the `❯ ` empty marker and a real
   multi-line draft, so extraction is pinned to observed renderings rather than
   invented ones.

## Risks

- **Clearing is a destructive act on a live PTY.** Contained by Stage 2's
  equality check and Stage 3's fail-loud-if-not-empty rule.
- **The kill key's scope is not fully verified.** Confirmed present upstream;
  multi-line behaviour must be established empirically before relying on it.
- **A second, independent bug shares this symptom.** When
  `snapshotComposerAttributes()` returns null, the string fallback fails closed
  and reads Claude's dim placeholder as a draft — reproduced on a real captured
  screen (same screen: `drafted` without attrs, `empty` with). That accounts for
  the ~52% of `human-draft` verdicts that fire nowhere near a submit. It is NOT
  what produces the reported "every prompt is refused" symptom and is tracked
  separately; fixing only it would leave this deadlock intact.
