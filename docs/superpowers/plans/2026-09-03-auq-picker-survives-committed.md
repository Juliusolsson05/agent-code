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

Secondary: the proxy synthesizes `turn_stopped` with `stopReason: null` on
stream death / stale-flow reap / API error, and `foldEvent` stamps the AUQ
block's `resultAt` from any non-`tool_use` stop, so the live row shows
"no answer sent" for a question that is still waiting.

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

C. **Only explicit terminal stops dismiss a pending question.**
   `foldEvent`'s `turn_stopped` branch stamps an AUQ block's `resultAt` only
   when `stopReason` is a real terminal reason; a synthesized stop
   (`stopReason === null`) leaves it unresolved. A picker orphaned by a
   genuine stream death lingers until the next `turn_started` archives the
   turn — bounded — and the committed decline result still lands.

Not changed: rules in `ownership.ts`, `committed.test.ts:180-210` (the
duplicate-capture guard) and the corpus fixtures.

## Verification

- `index.renderer.test.tsx`: the committed card renders the interactive
  picker when its operation id is live-unresolved and `result` is null;
  stays view-only when the id is absent, when a result exists, and when an
  answer via message was recorded.
- `foldEvent` test: a synthesized `turn_stopped` (`stopReason: null`) does
  not stamp a pending AskUserQuestion; an explicit `end_turn` still does;
  `tool_use` never does.
- Feed-level test: with a committed AUQ tool_use entry and a live
  `semanticTurn` holding the same unresolved block, the feed renders the
  interactive row (the fc397785 shape).
- `npx tsc -b`.
