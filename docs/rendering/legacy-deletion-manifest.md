# Legacy Rendering — Deletion Manifest

The contract for the complete strip-out of the old rendering system. The old
code is NOT deleted early: Stage 2 shadow mode diffs the new ledger against
the live legacy renderer, so the legacy path must keep working until cutover.
This manifest is what "starting fresh" means in practice — every legacy file
is enumerated with its fate and its deletion point, so nothing survives by
accident. LOC figures from the knowledge dump's Blast Radius appendix
(measured 2026-05-22; drifted slightly since, fates unchanged).

Legend: **DELETE** = removed entirely · **GUT** = file stays, ownership logic
removed (becomes dumb/plumbing) · **ABSORB** = behavior re-encoded in the
ledger, then source deleted · **KEEP** = not ownership code, survives as-is.

## Deleted at Stage 3 cutover (the big reviewed PR)

| file | phys LOC | fate | notes |
|---|---:|---|---|
| `features/feed/ui/semantic/StreamingTurn.tsx` | 149 | **DELETE** | atomically with ghost rule 3 (plan D6) — never one without the other |
| `features/feed/model/renderModel.ts` | 430 | **DELETE** | replaced by ledger + view model; `committedClaudeMessageTurnIds` naming lie dies with it |
| `features/feed/ui/semantic/renderUnits.ts` | 359 | **ABSORB** | committed-ownership skips → ledger reasons; collapsed-activity policy → view layer |
| `workspace/mergedEntries.ts` | ~200 | **ABSORB** | five-rule predicate → ledger ghost decisions; the entries pre-pass merge dies |
| `workspace/semantic/foldEvent.ts` | 987 | **GUT→ABSORB** | reducer stays (events→turn state); ALL ownership/suppression gates + fold policies move to ledger candidate rules; yield hatches become policy |
| `features/feed/ui/semantic/BlockRow.tsx` | 495 | **GUT** | becomes dumb rows; hardcoded provider dispatch replaced by the registry (same one committed rows use); all suppression branches deleted |
| `features/feed/ui/Feed.tsx` | 946 | **GUT** | maps view-model rows once; all plane/ownership/debug-derivation logic deleted; scroll/lazy stay per migration hazards |
| `features/feed/ui/rows/Block.tsx` | 204 | **GUT** | dispatch stays, ownership guards deleted |
| `workspace/ghosts.ts` | ~530 | **GUT** | minting/reconcile/persist stay (bookkeeping); render-side selection is ledger's |
| legacy `visible_rows`-only debug derivation | — | **DELETE** | replaced by ownership_decision serialization (visible_rows stays as aggregate) |

## Deleted during Stage 1 (already superseded, no shadow value)

- old fold-policy literals already replaced on main (#415) — nothing to do
- `workspace/queueInvariants.ts` — **ABSORB** into ledger queue-handoff rules
  at cutover, not before (echo providers still run through it live)

## KEEP (not ownership code)

| file | LOC | why it lives |
|---|---:|---|
| `markdown/Prose.tsx`, `MarkdownComponents.tsx`, remark plugins | ~250 | TextProse/StreamingProse split is load-bearing (migration hazard) |
| `lib/streamingWriteInput.ts` | 206 | Write-scanner, pure detector — feeds the view layer |
| `WorkIndicator.tsx` + hints | 305 | phase surface; consumes work candidates |
| row components (ToolUseRow/ToolResultRow/ConversationRow/Claude+Codex+OpenCode rows) | ~1600 | become dumb rows; only their embedded ownership guards die (counted under GUT above) |
| `lib/helpers.ts` committed text/tool index builders | 386 | logic ABSORBED into ownership.ts; file gutted at cutover |
| headless packages | ~11k | contract-tested, never rewritten (plan §10) |

## Verification of completeness at cutover

The Stage 3 PR is not mergeable until:
`grep -rn "SemanticStreamingTurn\|selectMergedEntries\|deriveFeedRenderModel\|committedClaudeMessageTurnIds\|buildSemanticRenderUnits" src/` returns only
hits inside `src/renderer/src/rendering/` history comments — i.e. every entry
in the DELETE/ABSORB tables above is gone or gutted, with its fixture green.
