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

import type { Entry } from '@shared/types/transcript'
import type { SessionRuntime } from '@renderer/workspace/workspaceState'
import type { ClaudeContentBlock, GhostEntry } from 'agent-transcript-parser/ghost'
import { mergeWithUpstream } from 'agent-transcript-parser/ghost'

// Sidecar-shape suppression — the symptom side of a known proxy-filter gap.
//
// WHAT this is fighting:
//   Claude Code routes auxiliary API calls (title gen, branch-name gen,
//   "predict the user's next prompt" follow-ups) through the same
//   /v1/messages endpoint as real turns. ClaudeProxyAdapter sees them as
//   live flows, publishes turn_started → text_delta → turn_completed
//   semantic events, ghostsFromSemanticTurn mints a ghost block. Claude
//   Code does NOT write these calls to its JSONL rollout, so
//   reconcileUpstream never matches a real entry, the orphan timeout
//   fires (~30s later), and mergeWithUpstream appends the ghost to the
//   tail of the feed. Each title-gen call leaves a 2-10 word fragment
//   permanently parked at the bottom of the conversation.
//
// WHY this lives in cc-shell instead of the headless filter:
//   ClaudeProxyAdapter already has a sidecar predicate (see commit
//   c8c2623, May 2026) that demotes flows by request body shape:
//     - max_tokens ≤ 1024 AND messageCount ≤ 3, OR
//     - one of four known system-prompt prefixes
//   That predicate misses the "predict-next-prompt" feature because the
//   call carries the full conversation history (messageCount > 3) and
//   uses a system prompt not in the prefix list. Forensic confirmation
//   from debug bundle 2026-05-07T08-26-35-212-5d948ab5: 7 orphan ghosts
//   visible at the bottom of the feed, none of 23 flows demoted, all
//   sidecar turns 12-41 chars and 188-602ms — well below any real
//   assistant turn (≥76 chars, ≥808ms in the same bundle).
//
//   Fixing the predicate properly requires the actual request body to
//   know the new system prompt template, which we don't have here.
//   This filter eliminates the symptom by detecting the SHAPE of the
//   leaked turn (short, single-block, plain text, assistant role,
//   orphaned) at render time.
//
// Trade-off / false-positive risk:
//   A genuinely brief assistant turn (e.g. "Done.") whose JSONL never
//   committed would also be suppressed. Acceptable because:
//     a) Orphans are already an error path — JSONL not landing means
//        upstream Claude Code crashed mid-turn.
//     b) The 200-char threshold is wider than any observed sidecar in
//        production bundles, so it errs toward keeping real content
//        visible at the cost of letting through marginal sidecars.
//     c) Permanent clutter from 6+ orphan titles is a daily UX harm;
//        a hidden 4-char crash response is a once-in-a-rare-while
//        invisible loss.
//
// Future work:
//   When we capture a live request body for the predict-next-prompt
//   feature, extend SIDECAR_SYSTEM_PROMPT_PREFIXES in claude-code-headless
//   and the body-shape predicate. At that point this renderer-side
//   filter becomes redundant and can be deleted.

// Cap chosen empirically against this user's debug bundle (max sidecar
// turn = 41 chars; min real assistant turn = 76 chars). 200 leaves
// headroom for slightly longer titles and a generous safety margin
// before we'd start cutting into real prose.
const SIDECAR_GHOST_TEXT_MAX = 200

function ghostHasSidecarShape(ghost: GhostEntry): boolean {
  // Only assistant orphans match — sidecars come back through the proxy
  // as assistant streams. User entries don't ghost (they get optimistic
  // user rows reconciled separately) and don't have this failure mode.
  if (ghost.message?.role !== 'assistant') return false
  const content = ghost.message?.content
  if (!Array.isArray(content)) return false
  // Single block. Real turns from a healthy proxy stream nearly always
  // carry at least a tool_use companion or fragmentation across blocks
  // even when short; a lone text block is the title-gen fingerprint.
  if (content.length !== 1) return false
  const block = content[0] as ClaudeContentBlock
  if (block.type !== 'text') return false
  // `text` is required on text blocks per atp's content type, but be
  // defensive — a malformed ghost should not crash the feed selector.
  const text = (block as { text?: unknown }).text
  if (typeof text !== 'string') return false
  return text.length <= SIDECAR_GHOST_TEXT_MAX
}

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

  // Render ghosts only after the orphan timeout has fired. Plain
  // unsuperseded ghosts are the normal handoff window between live
  // semantic streaming and JSONL; showing them immediately was the
  // source of duplicate/wrong-order feed rows. Orphaned ghosts are
  // different: the authoritative JSONL has not arrived in time, so
  // the ghost is the only surviving record of what the proxy observed.
  //
  // Current-turn ghosts are still excluded because
  // SemanticStreamingTurn owns the active live view. When that turn
  // completes and currentTurn becomes null, orphaned ghosts can step
  // in as the fallback transcript.
  const visibleGhosts = new Map<string, GhostEntry>()
  for (const [uuid, ghost] of ghosts) {
    if (ghost._atp.supersededBy !== undefined) continue
    if (ghost._atp.orphanedAt === undefined) continue
    if (currentTurnId !== null && ghost._atp.turnId === currentTurnId) {
      continue
    }
    // Suppress orphan ghosts that match Claude Code's sidecar
    // (title-gen / predict-next-prompt) shape. See the
    // ghostHasSidecarShape doc-comment above for the full rationale —
    // short version: these calls leak through the proxy, never land in
    // JSONL, get orphaned, and pile up at the bottom of the feed
    // forever. Detecting them by content shape is a renderer-side
    // workaround until the headless body-shape predicate is widened.
    if (ghostHasSidecarShape(ghost)) continue
    visibleGhosts.set(uuid, ghost)
  }
  if (visibleGhosts.size === 0) return entries

  return mergeWithUpstream(entries, visibleGhosts, {
    trustSupersededFlag: true,
  }) as Entry[]
}

/**
 * Whether Feed should render the live `SemanticStreamingTurn`
 * component. True iff there is a current turn — the merged feed
 * selector (`selectMergedEntries`) suppresses ghosts from the main
 * feed, so SemanticStreamingTurn has exclusive ownership of the
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
 *   ghosts + the merged feed. Until then, single-ownership in the
 *   main feed is the surgical fix.
 */
export function shouldShowSemanticStreaming(runtime: SessionRuntime): boolean {
  return runtime.semantic.currentTurn !== null
}
