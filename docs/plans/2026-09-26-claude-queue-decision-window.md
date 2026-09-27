# Bound the Claude queue decision log (#676)

## Problem

`ClaudeQueueState.decisions` is append-only for a session's lifetime ("The diagnosis IS this record",
principle P4). Every departure from the queue appends a `QueueDecision` carrying a content preview and
evidence. `pending` stays small, but `decisions` grows with lifetime queue churn.

Every append also copies the whole array (`[...state.decisions, …]`, 7 sites in `reconcile.ts`), so a
long session pays O(n) per departure and O(n²) overall.

## Evidence

- `claudeQueue/types.ts:125` declares the field; `reconcile.ts` appends at 7 sites.
- **Readers (origin/main):** none outside `reconcile.ts` and the tests.
  - The per-session state lives in `useIpcSubscriptions.ts`'s module-level `claudeQueueBySession` map,
    not in `SessionRuntime`, so it is not part of debug bundles either.
  - The UI (`QueueStrip`) renders `pending` and `stale`, not decisions.
- `reconcile.test.ts:253` asserts `settled.decisions.length === settled.nextSeq`: exact conservation
  across a whole recorded replay. A fix must keep an equivalent contract.

## Decisions (defaults)

- **A bounded window, not a cap that forgets silently.** Keep the most recent
  `QUEUE_DECISION_WINDOW = 200` decisions, the ones that explain what the queue is doing now (P4 is
  about diagnosing the current misattribution, not the session's history). Count what was evicted in
  `droppedDecisions`.
- **Conservation, restated exactly:** `decisions.length + droppedDecisions === nextSeq`. The test
  asserts that, so every departure is still accounted for.
- **One helper** (`withDecisions`) owns appending and trimming. The 7 hand-written spreads go away,
  which removes the per-departure whole-array copy beyond the window.
- 200 is generous. The recorded corpus replay produces well under that, so the existing corpus tests
  see every decision; only long-lived sessions ever evict.

## Tests

- **Fail-first:** a session that queues and consumes 1 000 prompts keeps at most 200 decisions, the
  newest are retained, and `decisions.length + droppedDecisions === nextSeq`. This fails on
  `origin/main` (1 000 retained).
- The corpus conservation assertion is restated with `droppedDecisions`.
- Existing decision-content assertions are unchanged.

## Review of #1364 (round 1: a, b and c, all FIX-BEFORE-MERGE)
- **The conservation claim was false (a, b, c).** `nextSeq` counts enqueues, while a pending item has no decision yet and a `stale-unattributed` mark is an extra decision.
  - `droppedDecisions` is restated as "evicted decision RECORDS": kept + evicted is every decision ever recorded.
  - The tests assert `== nextSeq` only for sessions that drained every item exactly once and never went stale, and say so.
- **A stranded episode lost all its evidence (c).** Replaying `divergence-stranded-background-commands` and adding 200 churn cycles kept 0 of the 164 decisions around the two still-stranded rows.
  - While any item is pending, the log may grow to `QUEUE_DECISION_CEILING = 2 000`.
  - Once the queue is empty it trims to `QUEUE_DECISION_WINDOW`, raised to 500: the corpus already has a 175-decision session, and 200 left 25 slots of margin.
  - **Stated residual:** a row stranded through more than 2 000 later decisions loses its oldest evidence.
- **Batch trim and the `popAll` path were unpinned (a, b):** both now have boundary tests.
- `markStaleWhenIdle`'s "has anything departed" guard now counts evicted decisions too.
- Mutations killed: a batch counted as one, `popAll` bypassing the bound, no pending ceiling.

## Review of #1364 (round 2: a and b MERGE-READY, c FIX-BEFORE-MERGE)
- **The ceiling only postponed the loss (c).** After 2 200 unrelated departures, none of the 164 decisions around the two stranded rows remained.
  - An episode opens when an item enters an empty queue (`episodeStart`) and closes when the queue is empty again.
  - While it is open, the FIRST decisions of the episode move into `episodeHead` (up to `QUEUE_EPISODE_HEAD = 200`) instead of being evicted.
  - The head and the log share the 2 000 ceiling. When the episode closes, the head is released and counted as dropped.
- **Two unpinned idle-path mutations (c):** stale marks must be bounded, and bounded by the pending queue. Both are now pinned.
- Mutations killed: no episode head, stale marks bounded by the empty window, stale marks unbounded, the head outside the ceiling.
- **Stated residual:** an episode's middle (after its first 200 decisions, before its most recent ~1 800) can still be evicted.

