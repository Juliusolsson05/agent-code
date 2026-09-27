# Bootstrap-complete archives a reopened turn without duplicating it (#1290)

## Problem
The bootstrap-complete reconciler (`useIpcSubscriptions.ts`) archives a still-open replayed turn with a raw `[...history, row]` append. Every other archive path uses `appendSemanticHistory`, which replaces by `turnId`. A replayed turn T already in history can reopen as `currentTurn`, and the ledger hides the copy while T is live. Bootstrap-complete then appended T again: two history rows with one turnId, repeated `sem:T:i` candidate ids, and duplicate `semantic-block:T:i` React keys. Found by the Stage 3 C8 hunt (`temp/quality-loop/hunt-c8.md`).

## Fix
The reconciler uses `appendSemanticHistory(next.semantic.history, closedTurn)`, the same helper as the other paths. It also applies the same `SEMANTIC_HISTORY_CAP`.

## Test
`bootstrapHistoryDedupe.renderer.test.tsx` drives the real `useIpcSubscriptions` through the fake session feed. It seeds T archived AND reopened, sends a replay burst, and lets the bootstrap-complete timer fire. It asserts one `turn-T` row. It was red before the fix (`['turn-T', 'turn-T']`).
