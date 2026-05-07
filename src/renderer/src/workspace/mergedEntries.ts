// Render-time selector: decide which (if any) ghost entries get
// merged into the rendered feed.
//
// -----------------------------------------------------------------------------
// Where ghost rendering fits in cc-shell today
// -----------------------------------------------------------------------------
//
// The live current turn is rendered by `SemanticStreamingTurn`
// directly off `runtime.semantic.currentTurn`, NOT through ghosts.
// JSONL writes catch up within ~100 ms via `reconcileUpstream` and
// supersede the ghost. Most ticks, the ghost map has no rendered
// output here at all.
//
// The one case ghost rendering exists for is JSONL stalling past
// the proxy. Two situations produce that:
//   1. Live-stuck: the agent process gets wedged or its writer
//      backlogs while the proxy keeps emitting events. Eventually
//      the orphan TTL fires and the ghost is the only record of
//      what happened for that turn.
//   2. Resume-after-crash: ghost log on disk has events past the
//      newest JSONL entry; JSONL never caught up before the
//      previous run died. On bootstrap, that ghost surfaces as the
//      lost partial turn.
//
// -----------------------------------------------------------------------------
// The layered predicate
// -----------------------------------------------------------------------------
//
// A ghost is render-eligible iff ALL of:
//   1. Not superseded.
//   2. Orphaned (TTL has elapsed without a JSONL match).
//   3. `turnId !== currentTurnId` (SemanticStreamingTurn owns that).
//   4. `_atp.updatedAt > lastJsonlEntryAt` (proxy state is past the
//      JSONL tail; structurally distinguishes the live-stuck case
//      from "ghost from earlier in the session that JSONL kept
//      writing past").
//   5. Not sidecar-shaped.
//
// Why rules 4 AND 5, not just rule 4:
//   The timestamp predicate is structurally correct for "stale
//   orphan from earlier in the session below newer commits," but
//   it cannot tell apart these two TAIL cases:
//     a) JSONL stopped mid-turn, ghost has the lost partial turn
//        (should render).
//     b) Last real JSONL entry committed at t=100, then a sidecar
//        leak (predict-next-prompt / title-gen / branch-name) at
//        t=105 with no later real turn to supersede it (should
//        NOT render).
//   Both have ghost.updatedAt > lastJsonlEntryAt and produce a
//   tail orphan with no JSONL counterpart. Rule 5 is a structural
//   shape check that matches Claude Code's known sidecar
//   fingerprint: assistant role + single text block + ≤200 chars.
//   Predict-next-prompt with full conversation history can exceed
//   the proxy-side budget predicate, but the response body is
//   short and shaped this way; matching at render time is the
//   backstop.
//
// Trade-off (knowingly accepted): a real assistant turn that
// crashed before any JSONL write AND was a single short text
// block (e.g. "Done.") would also be hidden. In production, that
// loss is rare; the alternative (orphan title-gen / next-prompt
// fragments piling up at the bottom of every session) is a daily
// UX harm. The trade is the same one commit 2a83978 made; this
// file keeps the shape filter while adding the timestamp gate
// that 686b94e was missing.
//
// -----------------------------------------------------------------------------
// Reference stability (load-bearing for Feed memos)
// -----------------------------------------------------------------------------
//
// Feed's row memos key off the `entries` array IDENTITY. When no
// ghost survives the predicate, this selector returns
// `runtime.entries` by identity, NOT a fresh `[...entries]`. The
// pre-fix `mergeWithUpstream` always returned `[...upstream,
// ...trailing]` even when `trailing` was empty, busting memos on
// every tick. atp's `mergeWithUpstream` is only called when
// `visible.size > 0`.
//
// Future work, not done here:
//   Phase 3 of the original headless redesign (delete
//   SemanticStreamingTurn, render the live current turn through
//   ghosts + ordered insertion in `mergeWithUpstream`) requires
//   atp learning to anchor by parentUuid / turnId / nearest
//   committed neighbor instead of always tail-appending. Until
//   that ships, the live current turn stays owned by
//   SemanticStreamingTurn and ghost rendering is reserved for the
//   JSONL-stalled-past-proxy fallback case described above.

import type { Entry } from '@shared/types/transcript'
import type { SessionRuntime } from '@renderer/workspace/workspaceState'
import type { ClaudeContentBlock, GhostEntry } from 'agent-transcript-parser/ghost'
import { mergeWithUpstream } from 'agent-transcript-parser/ghost'

// Cap chosen empirically against debug bundle 2026-05-07T08-26-35
// (max sidecar turn = 41 chars, min real assistant turn = 76
// chars). 200 leaves headroom for slightly-longer next-prompt
// variants and a generous safety margin before we'd start cutting
// into real prose. Same constant lived in mergedEntries.ts at
// commit 2a83978; reused here with the same threshold so the
// regression surface is unchanged.
const SIDECAR_GHOST_TEXT_MAX = 200

function ghostHasSidecarShape(ghost: GhostEntry): boolean {
  // Only assistant orphans match. Sidecars come back through the
  // proxy as assistant streams; user entries don't ghost (they get
  // optimistic-row reconciliation separately) and don't have this
  // failure mode.
  if (ghost.message?.role !== 'assistant') return false
  const content = ghost.message?.content
  if (!Array.isArray(content)) return false
  // Single block. Real assistant turns from a healthy proxy stream
  // nearly always carry at least a tool_use companion or
  // fragmentation across blocks even when short; a lone text block
  // is the title-gen / predict-next-prompt fingerprint.
  if (content.length !== 1) return false
  const block = content[0] as ClaudeContentBlock
  if (block.type !== 'text') return false
  // `text` is required on text blocks per atp's content type, but
  // be defensive — a malformed ghost should not crash the feed
  // selector.
  const text = (block as { text?: unknown }).text
  if (typeof text !== 'string') return false
  return text.length <= SIDECAR_GHOST_TEXT_MAX
}

/**
 * Render-time merge of `runtime.entries` with the surviving ghost
 * set. See the file-level WHY block above for the predicate
 * design.
 */
export function selectMergedEntries(
  runtime: SessionRuntime,
  currentTurnId: string | null,
): Entry[] {
  const { ghosts, entries, lastJsonlEntryAt } = runtime
  if (ghosts.size === 0) return entries

  const visible = new Map<string, GhostEntry>()
  for (const [uuid, ghost] of ghosts) {
    if (ghost._atp.supersededBy !== undefined) continue
    if (ghost._atp.orphanedAt === undefined) continue
    if (currentTurnId !== null && ghost._atp.turnId === currentTurnId) continue
    // Rule 4: only ghosts past the JSONL tail. Null
    // lastJsonlEntryAt (fresh session, never observed any JSONL
    // entry) falls through — rule 5 still applies, and the rest
    // of the predicate (orphaned + non-current) keeps this
    // narrow.
    if (lastJsonlEntryAt !== null && ghost._atp.updatedAt <= lastJsonlEntryAt) continue
    if (ghostHasSidecarShape(ghost)) continue
    visible.set(uuid, ghost)
  }
  if (visible.size === 0) return entries

  // Tail-append is correct for the surviving set: every visible
  // ghost is by predicate-3 not the active turn and by predicate-4
  // newer than every committed entry, so chronologically it
  // belongs at the very end.
  return mergeWithUpstream(entries, visible, {
    trustSupersededFlag: true,
  }) as Entry[]
}

/**
 * Whether Feed should render the live `SemanticStreamingTurn`
 * component. True iff there is a current turn — full stop. The
 * merged feed selector (`selectMergedEntries`) hides ghosts whose
 * `turnId === currentTurnId`, so SemanticStreamingTurn has
 * exclusive ownership of the live view and there is no
 * duplicate-render risk.
 */
export function shouldShowSemanticStreaming(runtime: SessionRuntime): boolean {
  return runtime.semantic.currentTurn !== null
}
