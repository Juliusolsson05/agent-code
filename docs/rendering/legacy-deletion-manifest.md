# Legacy Rendering — Deletion Manifest

This is the as-built deletion record for the ownership-ledger cutover and the
evidence-first provider painter. It is deliberately narrower than “delete old
looking code”: a file disappears only after its replacement owns the same
evidence in replay, and a central route stays when the replacement boundary
cannot yet express the facts it needs.

Legend: **DELETED** = no shipped source remains · **GUTTED** = plumbing/view
survives but its old decision or interpretation logic is gone · **KEPT** = a
current responsibility still depends on it · **PHASE 10** = intentionally
retained exception with a named replacement gate.

## Ownership-decision cutover (complete before PR #555)

The ledger is the sole visibility/order decision core for both desktop and the
remote client. The following runtime alternatives are gone:

| legacy route | fate | replacement proof |
|---|---|---|
| `deriveFeedRenderModel` and Feed's legacy branch | **DELETED** | desktop and remote both consume `useLedgerFeedItems`; bundle/recording corpus tests compare the ledger result |
| `deriveFeedCommittedProjection` and committed-turn re-suppression | **DELETED** | block-level ownership reasons in `rendering/model/ownership.ts` plus ledger bridge tests |
| `SemanticStreamingTurn` / `StreamingTurn.tsx` | **DELETED** | one ledger-approved `semantic-block` per drawable block; #491/#492 replay fixtures |
| `AGENT_CODE_RENDER_PIPELINE` / `AGENT_CODE_RENDER_SHADOW` runtime forks | **DELETED** | unconditional ledger producer; parity was green before cutover |
| runtime shadow mode | **DELETED** | `shadowDiff.ts` remains only as the pure corpus comparison engine |
| provider literals in the semantic fold | **GUTTED** | per-provider `semanticFoldPolicy.ts` reached through the registry |

`selectMergedEntries` and `buildSemanticRenderUnits` still exist, but neither is
a second feed decision core. The first is a ghost-folded entry source also used
by non-render consumers; the second supports the non-render prompt-ownership
predicate, debug bundles, and pure activity grouping. Deleting either merely
because its name appeared in the old manifest would mix unrelated state work
into the painter rewrite.

## Provider-painter cutover (PR #555 Phase 9)

Phase 9 removes split routes only after provider adapters and shape catalogs are
canonical. These queries are the permanent review recipe:

```sh
rg -n "@providers/(claude|codex|opencode)/renderer" \
  src/renderer/src/features/feed

rg -n "ClaudeRows|CodexRows|ToolUseRow|AskUserQuestionAnsweredRow|SemanticTodoList" \
  src

npx tsx --tsconfig tsconfig.web.json scripts/audit-rendering-shapes.mts
npx vitest run src/providers/importBoundaries.test.ts \
  src/providers/shapes.coverage.test.ts \
  src/renderer/src/rendering/bundleCorpus.test.ts \
  src/renderer/src/rendering/recordingCorpus.test.ts
```

The first query must have no shipped feed import. Historical WHY comments may
name a deleted file, but no module may import or call it. The audit must have no
current-fingerprint `unknown-structure`, `known-misrouted`, or
`unknown-outcome`; a frozen bundle predating receipts is reported as
`known-outcome-unobserved`, not assigned a fabricated generic owner.

| old route/decoder | fate | why deletion is now safe |
|---|---|---|
| `providers/claude/renderer/rows/ClaudeRows.tsx` feed barrel | **DELETED** | committed and semantic capabilities import provider components/adapters directly; the registry is the only shared-feed entry |
| `providers/codex/renderer/rows/CodexRows.tsx` feed barrel | **DELETED** | same; Codex live and durable planes converge through provider dispatch |
| central `ToolUseRow.tsx` | **DELETED** | every decline reaches the single bounded `JsonToolRow`, including open-world MCP and partial input |
| central `AskUserQuestionAnsweredRow.tsx` | **DELETED** | Claude question decoding and durable/live rows live under `providers/claude/renderer/`; condition state remains the sole interaction authority |
| central semantic `TodoList.tsx` | **DELETED** | evidence-backed tasks/plans are provider-owned; uncaptured TodoWrite does not inherit guessed legacy semantics |
| provider-name/tool-name branches in `SemanticLiveBlockRow` | **GUTTED** | it asks `renderSemanticBlock`; provider-neutral prose/reasoning/fallback remains central |
| three tool-result content flatteners | **DELETED** | `providers/shared/renderer/rows/toolResultContent.ts` is the loss-averse canonical text source; typed MCP/media views still receive original blocks |
| Claude semantic closed-string regex/JSON decoder | **DELETED** | the tested provider `extractJsonStringField` partial decoder is canonical for live edits |
| local bundle-sweep `asRecord` copy | **DELETED** | the shared strict plain-object helper rejects arrays consistently |

The fallback rows themselves are **KEPT**, not legacy. `JsonToolRow`,
`ToolResultRow`, lazy exact-source disclosures, `SystemRow`, and the normalized
unknown-semantic-object view make the painter total when a provider adapter
declines or upstream ships a new shape.

## Deliberate Phase 10 exceptions

Two central branches are retained because Phase 9 does not yet have the
operation-level evidence required to delete them safely:

| route | current owner | deletion gate |
|---|---|---|
| shell Git interception in `features/feed/ui/rows/Block.tsx` and result absorption into `features/git/ui/GitRows.tsx` | central paired tool indices + `shared.git-widget` receipt | provider `renderOperation` receives correlated use/result evidence; Git formatter fixtures cover decline, success, failure, restart/replay; no shared feed Git detection remains |
| durable compact boundary/summary selection in `features/feed/ui/rows/EntryRow.tsx` plus provider condition views | central entry dispatcher + provider condition registry | provider compaction adapters define structured/screen precedence and dedup; fixtures cover structured-only, fallback-only, both/disagreement, error/done, and restart/replay |

The persistent Git workspace bar is not a feed renderer and is **KEPT** after
Phase 10. Likewise, screen parsing may remain a versioned live-compaction
compatibility fallback; it must not remain the primary semantic source or the
owner of durable compact history.

## PR #524 port-or-reject inventory

PR #524 was read as a salvage source, not used as a base branch. Its global
artifact projection and shared provider classifiers violated the provider
boundary, but several low-level ideas were valuable. This table is the Phase 9
decision record required before closing that draft.

| PR #524 candidate | decision in #555 | as-built location / reason |
|---|---|---|
| ANSI SGR parsing, control-sequence hardening, span cap | **PORTED** | `renderer/lib/text/AnsiText.tsx` and tests; shared visual primitive, no provider decoding |
| bounded command output with head/tail preview and lazy exact source | **PORTED** | `renderer/lib/text/OutputWell.tsx`, `boundedText.ts`, `PagedTextViewer.tsx` |
| diff primitives and per-file summaries | **PORTED SELECTIVELY** | provider code-edit adapters → `providers/shared/renderer/protocols/code-edit/`; no universal artifact classifier |
| sealed-line streaming code cache | **PORTED** | `renderer/lib/code/StreamingCodeText.tsx`; Claude streaming Write/Bash uses it without remounting a full editor per delta |
| segmented streaming Markdown | **REJECTED FOR THIS REWRITE** | the draft performance claim was not needed to establish provider ownership; existing memoized `StreamingProse` remains, avoiding a second unrelated parser migration |
| safe partial JSON/string extraction | **PORTED PROVIDER-LOCALLY** | Claude `adapters/codeEdit.ts`, Codex `adapters/codeEdit.ts`/`command.ts`; no cross-provider extractor |
| lazy expansion and large-content caps | **PORTED** | `PagedTextViewer`, `LazyJsonDisclosure`, `JsonResultSlab`, structured/MCP views |
| status vocabulary, path labels, disclosure primitives | **PORTED SELECTIVELY** | narrow shared protocol models/views and existing `formatToolFilePath`; providers keep lifecycle interpretation |
| real wire discoveries and regression fixtures | **PORTED SELECTIVELY** | checked-in rendering bundles and `testing/fixtures/rendering-shapes/`; unsupported generations carry explicit catalog TODOs |
| omission/projection receipts | **REIMPLEMENTED AT THE PAINT BOUNDARY** | shape sightings record specialized/generic/absorbed/condition/unknown outcomes; no `OperationVM → ArtifactVM` double projection |
| global 17-family taxonomy and `presentation/` classifier | **REJECTED** | tool names and raw wrappers are provider vocabulary; provider adapters map only proven shapes into shared protocols |
| shared classifiers importing provider extractors | **REJECTED** | forbidden by `src/providers/importBoundaries.test.ts` |
| wholesale deletion of `Block`, `ConversationRow`, semantic rows, and result rows | **REJECTED** | those files still own neutral paint/fallback and the two documented Phase 10 exceptions |

## Completion boundary

Phase 9 is complete when the catalog/corpus queries above are green, all
current `fp2` recording observations have a non-unknown accountable outcome,
the full suite/build passes, this evergreen record matches the import graph,
and PR #524 is closed as superseded by #555. This is not the end of the rewrite:
the two Phase 10 exceptions remain deliberately visible here so “legacy
deletion complete” cannot be misread as permission to merge #555 early.
