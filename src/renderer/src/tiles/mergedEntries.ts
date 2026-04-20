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
 *   - if `runtime.ghosts` is empty, returns `runtime.entries` as-is
 *     (same reference), so memoized consumers never re-render.
 *   - otherwise returns a fresh array. Feed's memoization already
 *     works correctly against array identity for the in-flight tail.
 */
export function selectMergedEntries(runtime: SessionRuntime): Entry[] {
  if (runtime.ghosts.size === 0) return runtime.entries
  return mergeWithUpstream(runtime.entries, runtime.ghosts) as Entry[]
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
