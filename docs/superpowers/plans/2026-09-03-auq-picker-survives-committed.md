# Feed: keep the AskUserQuestion picker interactive after the committed row lands

Fixes #738. Refs #601, #290, #289, #98.

## Problem

`dispatch.tsx` renders the interactive picker only for the LIVE (semantic)
plane with no result; the committed JSONL plane always renders the view-only
`ClaudeAnsweredQuestionRow`. The rendering ledger hands ownership of a
`tool_use` to the committed row the instant that entry lands
(`ownership.ts:199-204`, "committed-tool-use-owned", introduced by slice 18
to remove a duplicate capture), and Claude Code appends the assistant
message before it runs the picker. With a healthy transcript tail the
interactive row never paints, or flashes for one tick — the question is
answerable from Agent Code only when the JSONL channel is broken.

Secondary, out of scope here: the proxy synthesizes `turn_stopped` with
`stopReason: null` on stream death / stale-flow reap / API error and
`foldEvent` stamps the AUQ block's `resultAt` from it. Changing that was
tried and dropped in review (see Design).

## Design

A. **The committed card turns interactive while the live plane still holds
   the question unresolved.** Feed derives the set of `toolUseId`s of
   `AskUserQuestion` blocks in `semanticTurn` (the current turn only — a
   turn that has been archived to history is no longer blocking the TUI)
   with `resultAt == null`, and provides it through a new
   `LiveUnresolvedQuestionsContext` next to `AskUserQuestionConditionContext`.
   `ClaudeAnsweredQuestionRow` renders `AskUserQuestionRow` when
   `result === null`, no answer-via-message was recorded, and its
   `operationId` is in that set. The ledger, ownership rules and the corpus
   are untouched; liveness proof comes from the semantic plane, so after a
   reload with no semantic evidence the card stays view-only — honest.

B. **The submit latch follows the question, not the row instance.** The
   live-plane row unmounts when the ledger hands the tool_use to the
   committed row, which can happen while the resolver is still typing the
   first answer; the committed card then mounts a fresh `AskUserQuestionRow`.
   A per-instance `useState`/`useRef` latch dies with the old instance, so
   the new one would accept a second answer. The latch now lives in
   `useAnswerSubmissionStore`, keyed by `operationId`, read synchronously
   for the same-tick double-click guard and subscribed for the "Answering…"
   affordance.

Rejected: treating a synthesized `turn_stopped` (`stopReason: null`) as
non-terminal in `foldEvent`. It changed the semantic plane's stop contract
for every consumer to serve one row, and the "no answer sent" flash it
targeted was not reproduced; if it recurs it gets its own issue.

Not changed: rules in `ownership.ts`, `committed.test.ts:180-210` (the
duplicate-capture guard) and the corpus fixtures.

## Verification

- `index.renderer.test.tsx`: the committed card renders the interactive
  picker when its operation id is live-unresolved and `result` is null;
  stays view-only when the id is absent, when a result exists, and when an
  answer via message was recorded.
- `index.renderer.test.tsx`: an answer recorded via message wins over the
  live-unresolved signal (view shows "Answered via message", no picker).
- `answeredViaMessageStore` latch: the in-flight flag is visible to a second
  row instance for the same operationId and cleared on `end`.
- `npx tsc -b`.
