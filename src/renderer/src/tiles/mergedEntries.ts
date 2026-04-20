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

import { mergeWithUpstream } from 'agent-transcript-parser/ghost'

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
export function selectMergedEntries(runtime: SessionRuntime): Entry[] {
  const { ghosts, entries } = runtime
  if (ghosts.size === 0) return entries
  let anyVisibleGhost = false
  for (const ghost of ghosts.values()) {
    if (ghost._atp.supersededBy !== undefined) continue
    anyVisibleGhost = true
    break
  }
  if (!anyVisibleGhost) return entries
  // `trustSupersededFlag` is load-bearing for cc-shell: the renderer
  // only ever holds a RECENT TAIL of `runtime.entries` (resume brings
  // the last ~200 committed entries; older history pages on demand),
  // so the target uuid of a ghost's `supersededBy` is often out of
  // the loaded slice. Without the flag, atp's default behaviour is
  // "if I can't see the target, show the ghost" — which on resume
  // resurfaces every ghost that already got reconciled in a prior
  // session. See atp's ghost.ts MergeOptions docstring for the full
  // rationale.
  return mergeWithUpstream(entries, ghosts, { trustSupersededFlag: true }) as Entry[]
}

/**
 * Decide whether Feed should still render the live
 * `SemanticStreamingTurn` component for the current turn, or whether
 * ghost entries are already covering it.
 *
 * WHY both paths still exist at Phase 1:
 *
 *   Ghost entries render through Feed's normal `EntryRow` dispatch —
 *   same `text` / `tool_use` / `thinking` renderers as committed
 *   entries. That's correct for most cases, but it loses the
 *   fine-grained live typography that `SemanticStreamingTurn` adds
 *   (remark-breaks for partial text, live work-indicator for empty
 *   thinking, streaming-fence detection). Rather than rip all that
 *   out in one go, we let ghosts take over the turn ONLY when they
 *   have any un-reconciled entry for it. Turns that happen to have
 *   zero translatable blocks (e.g. a turn whose only block is an
 *   encrypted reasoning that `blocksFromSemantic` drops) still get
 *   the legacy live render.
 *
 *   Phase 3 deletes `SemanticStreamingTurn` entirely; this function
 *   goes away with it.
 */
export function shouldShowSemanticStreaming(runtime: SessionRuntime): boolean {
  const turn = runtime.semantic.currentTurn
  if (!turn) return false
  for (const ghost of runtime.ghosts.values()) {
    if (ghost._atp.turnId !== turn.turnId) continue
    if (ghost._atp.supersededBy !== undefined) continue
    return false
  }
  return true
}
