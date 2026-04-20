// Render-time selector: merge upstream entries with current ghost
// state into the single Entry list Feed consumes.
//
// WHY this lives in its own file:
//   The merge is called from TileLeaf's render path, and memoization
//   needs stable references. Putting the selector alongside the
//   ghost reducer keeps the integration surface tiny — TileLeaf
//   imports one function from one place; workspaceStore imports
//   reducer helpers from `./ghosts`; Feed imports nothing about
//   ghosts at all. That separation is load-bearing: when Phase 3
//   deletes the old "two owners" branch in Feed.tsx, Feed will
//   simply consume the merged list with no awareness of ghosts.
//
// The merge is a thin wrapper around atp's `mergeWithUpstream` so
// the provenance and semantics stay documented in one place (the
// atp doc). This file adds nothing to the merge rules; it only
// chooses atp's default options and threads the runtime's state.

import { mergeWithUpstream, type GhostEntry } from 'agent-transcript-parser/ghost'

import type { Entry } from '../../../shared/types/transcript'
import type { SessionRuntime } from './workspaceState'

/**
 * Merged entry list for rendering. Superseded ghosts are dropped;
 * orphaned ghosts stay visible (they're the only record of the
 * block).
 *
 * Reference stability:
 *   - if `runtime.ghosts` is empty OR every ghost in the map has
 *     been superseded, returns `runtime.entries` as-is. That short-
 *     circuit is what keeps Feed's useMemo([entries]) chain from
 *     thrashing once the live turn is done and all ghosts have
 *     handed off to the committed JSONL entries.
 *   - otherwise returns a fresh array from mergeWithUpstream. Feed's
 *     memos recompute, which is correct: there is at least one
 *     provisional ghost visible and the list is genuinely different
 *     from `runtime.entries`.
 *
 * WHY not always call mergeWithUpstream: the previous implementation
 * did, and even when `trailing` ended up empty, the return was still
 * `[...upstream, ...[]]` — a fresh array reference. Downstream memos
 * keyed on entries identity recomputed on every tick, so the
 * "memoization path is unchanged" promise in the old docstring was
 * only theoretical.
 */
export function selectMergedEntries(
  runtime: SessionRuntime,
  currentTurnId: string | null,
): Entry[] {
  const { ghosts, entries } = runtime
  if (ghosts.size === 0) return entries

  // Split ownership: the LIVE turn (runtime.semantic.currentTurn) is
  // drawn by SemanticStreamingTurn; earlier turns' orphaned or
  // still-unreconciled ghosts belong to the merged feed. Filtering
  // current-turn ghosts out of the merge is what removes the null-
  // flip that the feed-debug log showed at id:131 — the old
  // `shouldShowSemanticStreaming` hid the entire live view the
  // moment any un-superseded ghost for the current turn existed,
  // and a tool_use block's ghost fires before its upstream commit
  // every single turn. See
  // docs/superpowers/plans/2026-04-20-rendering-fixes.md Task 5.
  let anyVisibleGhost = false
  let needsFilter = false
  for (const ghost of ghosts.values()) {
    if (ghost._atp.supersededBy !== undefined) continue
    if (currentTurnId !== null && ghost._atp.turnId === currentTurnId) {
      needsFilter = true
      continue
    }
    anyVisibleGhost = true
  }
  if (!anyVisibleGhost) return entries

  // `trustSupersededFlag` is load-bearing for cc-shell: the renderer
  // only ever holds a RECENT TAIL of `runtime.entries` (resume brings
  // the last ~200 committed entries; older history pages on demand),
  // so the target uuid of a ghost's `supersededBy` is often out of
  // the loaded slice. Without the flag, atp's default behaviour is
  // "if I can't see the target, show the ghost" — which on resume
  // resurfaces every ghost that already got reconciled in a prior
  // session. See atp's ghost.ts MergeOptions docstring.
  if (!needsFilter) {
    return mergeWithUpstream(entries, ghosts, { trustSupersededFlag: true }) as Entry[]
  }
  const filtered = new Map<string, GhostEntry>()
  for (const [uuid, ghost] of ghosts) {
    if (currentTurnId !== null && ghost._atp.turnId === currentTurnId) continue
    filtered.set(uuid, ghost)
  }
  return mergeWithUpstream(entries, filtered, { trustSupersededFlag: true }) as Entry[]
}

/**
 * Whether Feed should render the live `SemanticStreamingTurn`
 * component. True iff there is a current turn — the merged feed
 * selector (`selectMergedEntries`) filters out the current turn's
 * ghosts, so SemanticStreamingTurn has exclusive ownership of the
 * live view and there is no duplicate-render risk.
 *
 * WHY the old predicate was wrong:
 *   It returned false the moment any un-superseded ghost for the
 *   current turn existed — which happens on every block transition,
 *   because tool_use ghosts are minted BEFORE their upstream entry
 *   commits. The live view flicker/null-flip at id:131 in the
 *   2026-04-20 rendering-fixes evidence log was that gate tripping.
 *
 *   Phase 3 of the original headless redesign will delete
 *   SemanticStreamingTurn entirely and render everything through
 *   ghosts + the merged feed. Until then, single-ownership via
 *   `selectMergedEntries(..., currentTurnId)` is the surgical fix.
 */
export function shouldShowSemanticStreaming(runtime: SessionRuntime): boolean {
  return runtime.semantic.currentTurn !== null
}
