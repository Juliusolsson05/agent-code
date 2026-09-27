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
