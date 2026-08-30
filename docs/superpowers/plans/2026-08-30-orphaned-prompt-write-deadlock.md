# Recovering from an orphaned prompt write

> Refs #679

## Status: rewritten after review

The first version of this plan was reviewed by three agents and was wrong in
three ways. It is replaced rather than patched, because the shape changed.
What the review established is recorded below, because the discarded reasoning
is the most useful part of this document.

**The diagnosis was over-claimed.** "Every subsequent delivery is refused,
forever" is not what the data shows. Of 10 recorded orphaned writes, **7
recovered on their own** (6.7s–221s, no restart); exactly one latched. Worse,
**52 of 57 `not-ready` refusals have no orphaned write anywhere on their
session** — this mechanism explains at most 5 of them. The session that actually
matches the user's report (five consecutive refusals in four seconds, then the
pane killed) has **no orphaned write**, and the three longest occupied episodes
(47.5h, 23.5h, 11.5h) have none either.

So: this bug is real, reproduced from a PTY recording, and worth fixing. It is
**not** the whole of what the user hit. The remaining producer of a latched
`human-draft` is unidentified and tracked separately.

**"Nothing clears the composer" was literally false.** `useComposerKeybinds.ts`
already sends `\x15`, and `TileLeaf.tsx` sends `\x1b`. The substance held — none
is automatic, and the composer-keybind paths are gated on `inputReady`, which is
exactly what an occupied gate clears — but the claim as written was wrong.

**The proposed design would have destroyed user input.** It gated clearing on
"composer text still equals what we wrote", which is not proof of anything: the
extractor reads a viewport-clipped, wrap-lossy projection, the orphan record
never expired (becoming a standing licence to delete that string whenever it
reappeared — e.g. recalled with ↑), and for the dominant prompt shape equality
can never hold at all, because Claude collapses paste-like input to
`[Pasted text #N +M lines]`.

## What replaces it

The review supplied a strictly better ownership proof than text equality.

`SessionManager.write()` **refuses raw input while a delivery holds the
session's reservation** (`promptDeliveriesInFlight`, taken before
`deliverPrompt` and released in a `finally`). So for the entire duration of
`deliverClaudePrompt`, no human keystroke can reach that composer.

Anything in the composer during delivery is therefore **provably ours**, by
construction. No text comparison, no orphan record, no composer-text extractor,
no new gate state. The old plan's Stages 0–2 are deleted outright.

### The clear primitive: Ctrl+U, and NOT Esc

Both reviewers recommended double-Esc, because upstream it clears the whole
composer and — importantly — calls `addToHistory(originalValue)` first, so the
text is recoverable with ↑ (`vendor/.../hooks/useTextInput.ts:126-152`).

**That recommendation is wrong here, and the reason is specific to when we would
send it.** `\x1b` is the byte Agent Code's own Stop button sends
(`TileLeaf.tsx:889`: *"Same escape byte the keyboard interrupt sends… interrupting
is the provider's own protocol"*). Esc clears the composer only when Claude is
IDLE; when Claude is RUNNING it interrupts the turn. Absorption times out
precisely **because Claude is mid-turn** — the confirmed case shows the prompt
repainting 2.6s after the write while Claude was busy. Sending Esc there would
abort the agent's work: strictly worse than the deadlock.

`Ctrl+U` (`\x15`) is correct precisely because it is *not* overloaded with
interrupt. Its cost is that it is kill-to-**visual**-line-start
(`vendor/.../utils/Cursor.ts:880-893`), so a wrapped prompt needs several
presses and the count is width-dependent. That is a bounded-loop problem, which
is tractable; Esc's problem is not.

The loop is safe to abort because consecutive kills accumulate into a single
kill-ring entry with `'prepend'` (`Cursor.ts:26-48`; `lastActionWasKill` is
reset only by a non-kill key), so **one `Ctrl+Y` restores everything** the loop
removed.

## Design

### Stage 1 — Stop manufacturing orphans

`CONFIRM_TIMEOUT_MS` is 2000ms. All ten recorded failures ended at 2002–2034ms:
the cap fired every time. In the one case with a PTY recording, the prompt
actually appeared at **2575ms** — it would have been confirmed by a 5s budget.

Raise text absorption to 5s, matching the existing image path
(`IMAGE_CONFIRM_TIMEOUT_MS`). Normal sends pay nothing: the poller exits on
first match.

This is the highest-value change in the plan and it is one constant. It does not
*fix* the deadlock; it stops walking into it.

Note a real budget inconsistency to address or explicitly refuse: 12s readiness
+ 7s absorption leaves 9s for an acceptance waiter documented as needing 20s to
outlast a 15s watchdog. Delivery should refuse to cross the write boundary
without the minimum post-write budget rather than starting a write it cannot
confirm.

### Stage 2 — Roll back inside the reservation

Every path in `deliverClaudePrompt` that returns with bytes written and Enter
not sent must first attempt rollback, while the reservation is still held:

1. Send `\x15`.
2. Re-read composer state. Require strict progress — each read must shrink.
3. Repeat to a bounded press count.
4. **Reached `empty`** → return `retrySafe: true`, `disposition: 'retry-same-session'`,
   with a message stating the prompt was not sent and the draft is preserved in
   the app composer. The renderer does not clear its textarea on failure, so the
   user's text is never the only copy.
5. **Did not reach `empty`** → send `Ctrl+Y` (`\x19`) to restore what the loop
   removed, then return the existing `do-not-retry` failure. Never leave a partially cleared
   composer, which would produce exactly the mangled submission this subsystem
   exists to prevent.

The paths to cover, not just the observed one: text absorption timeout, Enter
write-failed, image-prompt text absorption timeout, separator write failed,
image paste write failed with a non-empty prompt, image absorption timeout, and
image Enter write-failed.

### Stage 3 — Make a latched gate visible

`readiness.ts` maps every non-ready verdict to `'waiting for agent'`, and the
detailed reason is collapsed to `provider-not-ready` before leaving main. Both
files flag this as a known deliberate gap. It is why this bug needed a journal
dig to find, and #679 lists it as an acceptance criterion, so it ships here
rather than being deferred — if it proves large enough to split, this plan's PR
says `Refs #679` and the issue stays open.

## Testing

1. **Rollback returns the composer to empty and reports retry-safe.** Drive an
   absorption timeout; assert the composer is empty and the result is
   retryable. Must fail against `main`.
2. **A failed rollback restores rather than mangles.** Force the clear to stall;
   assert `Ctrl+Y` is sent and the result is `do-not-retry`. This is the
   safety property and the one a later refactor is most likely to drop.
3. **Bounded.** The loop cannot spin indefinitely on a composer that never
   shrinks.
4. **The 5s budget confirms the recorded slow case.** Use the real 2575ms
   appearance from the `d71c40a4` recording, not an invented delay.
5. **Every orphan path rolls back**, not only absorption timeout.

## Risks

- **Writing destructive bytes into a live PTY.** Contained by the reservation
  (no human bytes can be present), the strict-progress requirement, and the
  `Ctrl+Y` restore.
- **Press count is width-dependent and not knowable in advance.** Handled by
  verify-after-each-press rather than by computing a count.
- **`Ctrl+Y` restore is inferred from upstream source, not yet observed.** It
  must be proven against a real composer before the rollback path is trusted;
  if it cannot be, the loop must not run at all.
- **This does not explain the other 52 refusals.** Separate investigation.
