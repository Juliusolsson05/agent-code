// Ghost-record bridge between the live semantic reducer and the
// durable JSONL transcript.
//
// -----------------------------------------------------------------------------
// WHY this exists
// -----------------------------------------------------------------------------
//
// The Feed used to have two independent owners of visible assistant text:
//
//   1. committed transcript entries read from disk JSONL (`runtime.entries`)
//   2. the live semantic tail (`runtime.semantic.currentTurn`)
//
// Feed rendered both unconditionally — upstream entries first, then the
// live tail below. That worked while upstream's write was same-tick with
// the live event, which it is NOT. Upstream Claude Code writes transcript
// JSONL fire-and-forget on a 100 ms batched drain (10 ms for remote
// sessions), and Codex's RolloutRecorder queues writes through a tokio
// mpsc to a background task that persists on explicit flush barriers.
// Both CLIs intentionally let the live view lead, then eventually catch
// up.
//
// That design is fine for the CLI's own TUI, which is the ONLY consumer
// and knows never to show both views at once. It breaks for cc-shell,
// which reads the durable JSONL AND consumes the live semantic channel
// and must merge the two into one feed. The observed symptom was a
// duplicate-render bug on Codex: committed assistant entry plus live
// rollout semantic turn rendered the same sentence twice.
//
// The fix is a transcript-first feed with a ghost overlay. Ghosts are
// minted from live semantic state as a provisional `ClaudeEntry` with
// `_atp.origin = 'ghost'`, reconciled against upstream entries as they
// land, and merged at read time via `mergeWithUpstream`. Once the real
// entry exists, the ghost is superseded and drops out of the merged
// list. If the real entry never arrives, the ghost is orphaned and
// stays visible as the sole record of what the live layer saw.
//
// See `agent-transcript-parser/docs/ghost.md` for the full primitive,
// and the 2026-04-18 plan in cc-shell's docs for the integration.
//
// -----------------------------------------------------------------------------
// Layering
// -----------------------------------------------------------------------------
//
//   atp                — agent-agnostic primitives (`createGhost`,
//                        `updateGhost`, `supersedeGhost`, `orphanGhost`,
//                        `reduceGhostLog`, `mergeWithUpstream`)
//   cc-shell/ghosts.ts — THIS FILE. Pure functions that bridge
//                        `SemanticLiveTurn` → ghost entries and fold
//                        upstream ingest into supersedes.
//   workspaceStore.ts  — calls the two functions here at the semantic
//                        fold site and the JSONL ingest site. Disk
//                        persistence (Phase 2) is owned by
//                        `src/main/ghostJournal.ts`.
//   Feed.tsx           — consumes the merged Entry list via a derived
//                        selector; never sees ghost/non-ghost
//                        distinction at the component level.
//
// No function here performs IO. No function here subscribes to events.
// Input goes in, new `Map<uuid, GhostEntry>` comes out.

import {
  createGhost,
  ghostUuid,
  orphanGhost as orphanGhostRecord,
  supersedeGhost,
  updateGhost,
  type ClaudeContentBlock,
  type ClaudeToolUseBlock,
  type ClaudeTextBlock,
  type ClaudeThinkingBlock,
  type GhostEntry,
} from 'agent-transcript-parser/ghost'

import type { Entry } from '../../../shared/types/transcript'
import { isConversationEntry } from '../../../shared/types/transcript'
import type {
  SemanticLiveBlock,
  SemanticLiveTurn,
} from './workspaceState'

// -----------------------------------------------------------------------------
// Semantic block → Claude content blocks
// -----------------------------------------------------------------------------

/**
 * Translate a single `SemanticLiveBlock` into the ClaudeContentBlock[]
 * shape the ghost needs. Keeps this conversion in one place so every
 * semantic block kind has exactly one translation rule.
 *
 * WHY output `ClaudeContentBlock[]` and not a single block:
 *   Some semantic blocks (e.g. Codex `message` with both text and
 *   a citation list) naturally produce more than one Claude block,
 *   and some produce zero (e.g. a blank reasoning block with no
 *   plaintext). Returning an array lets callers treat the conversion
 *   uniformly without branching on "did this block yield anything?"
 */
export function blocksFromSemantic(
  block: SemanticLiveBlock,
): ClaudeContentBlock[] {
  switch (block.kind) {
    case 'text':
    case 'message': {
      // Codex messages and Claude text blocks both land as plain
      // `text` content. Codex-specific `messagePhase` (commentary /
      // final_answer) does NOT affect the block shape — it's
      // provenance-only. If a consumer wants to style by phase they
      // can read `_atp.context.messagePhase` (set below).
      const text = block.text ?? ''
      if (!text) return []
      const claudeBlock: ClaudeTextBlock = { type: 'text', text }
      return [claudeBlock]
    }

    case 'thinking':
    case 'reasoning': {
      // Claude's `thinking` plaintext is stripped on persistence,
      // so the ghost carries it for the live view; once the real
      // entry lands with an empty `thinking` the ghost is still
      // superseded (we match by uuid / turnId, not by content).
      // Codex `reasoning` is often encrypted (empty plaintext) —
      // emit nothing rather than a hollow block so the UI doesn't
      // render an empty thinking details element.
      const raw =
        block.thinking ||
        block.reasoningSummary ||
        block.reasoningText ||
        ''
      if (!raw) return []
      const thinking: ClaudeThinkingBlock = {
        type: 'thinking',
        thinking: raw,
        ...(block.signature ? { signature: block.signature } : {}),
      }
      return [thinking]
    }

    case 'tool_use':
    case 'server_tool_use':
    case 'mcp_tool_use':
    case 'function_call':
    case 'custom_tool_call': {
      // Tool use blocks map cleanly into Claude's `tool_use`. `input`
      // comes from parsedInput when available (JSON-parsed), otherwise
      // the raw inputJson string as a fallback — a consumer rendering
      // the ghost still needs to show SOMETHING while the arguments
      // stream in partial form.
      const id = block.toolUseId ?? block.callId
      if (!id) return []
      const name = block.toolName ?? block.kind
      const input =
        block.parsedInput !== undefined
          ? block.parsedInput
          : typeof block.inputJson === 'string' && block.inputJson.length > 0
            ? { __rawJson: block.inputJson }
            : {}
      const toolUse: ClaudeToolUseBlock = {
        type: 'tool_use',
        id,
        name,
        input,
      }
      return [toolUse]
    }

    // Codex's output-side variants land separately as their own blocks
    // on the wire. We leave them out of ghost emission because the
    // matching authoritative `tool_result` arrives in the upstream
    // JSONL — and attempting to synthesize a provisional tool_result
    // would fabricate output the model never produced. Ghosting
    // tool-call INPUTS (above) is safe; ghosting tool OUTPUTS would
    // not be.
    case 'function_call_output':
    case 'custom_tool_call_output':
    case 'tool_search_output':
    case 'tool_result':
      return []

    // Codex-specific server-executed tools (web search, image
    // generation, local shell). We could ghost these the same way as
    // generic tool_use, but their inputs are opaque JSON blobs that
    // the live UI already renders via semantic state, and the
    // authoritative rollout entry doesn't come back as a paired
    // Claude tool_result anyway. Skipping them keeps the ghost stream
    // narrowly focused on the blocks that would otherwise collide
    // with upstream assistant text/tool_use entries.
    case 'web_search_call':
    case 'image_generation_call':
    case 'local_shell_call':
    case 'tool_search_call':
      return []

    default:
      return []
  }
}

// -----------------------------------------------------------------------------
// Turn → ghosts (called from the semantic fold site)
// -----------------------------------------------------------------------------

/**
 * Produce or refresh ghosts for the current semantic turn.
 *
 * Called on every semantic reducer tick that mutates `currentTurn`.
 * The function is idempotent and deterministic: the same (turn, prev)
 * input always yields the same output Map, so callers can invoke it
 * liberally without worrying about duplicate writes.
 *
 * WHY return a new Map rather than mutating:
 *   Consumers may be holding the previous map for rendering or
 *   logging. Mutation would silently corrupt those captures. The
 *   cost of a fresh Map per tick is negligible (~size of turn) and
 *   the pure-function invariant makes the reducer trivially testable.
 *
 * Ghost lifecycle decisions:
 *   - A new block → `createGhost` mints a deterministic-uuid entry.
 *   - An existing block whose content changed → `updateGhost` bumps
 *     `updatedAt` and swaps in the new content. The uuid is stable.
 *   - An existing ghost whose block disappeared from `turn.blocks`
 *     (can happen mid-turn if the semantic reducer rewrote the turn
 *     on a flow switch) → left in prev untouched. We do NOT orphan
 *     here because disappearance inside an active turn is not the
 *     same signal as "upstream never wrote this." `orphanStale`
 *     below handles the timeout-based orphan case.
 *
 * Ghosts for OTHER turns in `prev` are preserved — a turn can have
 * completed with an un-reconciled tail while a new turn is already
 * mid-stream, and losing those would nuke the previous orphan.
 */
export function ghostsFromSemanticTurn(
  turn: SemanticLiveTurn | null,
  sessionId: string,
  prev: ReadonlyMap<string, GhostEntry>,
): Map<string, GhostEntry> {
  // WHY lazy clone: this runs on every semantic reducer tick,
  // including no-op ticks (usage_updated, redundant block_started).
  // The pre-fix version always allocated `new Map(prev)` at the top,
  // which made `nextGhosts !== current.ghosts` always true downstream,
  // forcing a setRuntimes cascade that busted every useMemo([entries])
  // in Feed via selectMergedEntries. Clone ONLY when we actually have
  // a mutation to land; most ticks return `prev` unchanged and Feed's
  // memoization stays intact.
  if (!turn) return prev as Map<string, GhostEntry>

  let next: Map<string, GhostEntry> | null = null

  for (const block of Object.values(turn.blocks)) {
    const content = blocksFromSemantic(block)
    if (content.length === 0) continue

    const uuid = ghostUuid(turn.turnId, block.blockIndex)
    const existing = prev.get(uuid)

    // Once a ghost has been superseded, leave it alone — the
    // authoritative record is in play and further live updates are
    // meaningless for rendering. This also protects against a late
    // semantic delta arriving after the real upstream entry landed.
    if (existing?._atp.supersededBy !== undefined) continue

    if (!existing) {
      if (next === null) next = new Map(prev)
      next.set(
        uuid,
        createGhost({
          sessionId,
          turnId: turn.turnId,
          blockIndex: block.blockIndex,
          role: 'assistant',
          content,
          context: ghostContextForBlock(block, turn),
        }),
      )
      continue
    }

    // Skip churn-free updates: if the already-stored ghost has the
    // same content as what this tick would produce, return the
    // existing ghost to preserve reference equality. Pure-function
    // callers use that identity to skip re-renders.
    if (sameClaudeContent(existing.message?.content, content)) continue

    if (next === null) next = new Map(prev)
    next.set(uuid, updateGhost(existing, content))
  }

  return next ?? (prev as Map<string, GhostEntry>)
}

function sameClaudeContent(
  a: unknown,
  b: ClaudeContentBlock[],
): boolean {
  if (!Array.isArray(a)) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) return false
  }
  return true
}

function ghostContextForBlock(
  block: SemanticLiveBlock,
  turn: SemanticLiveTurn,
): Record<string, unknown> {
  // `context` is atp's free-form consumer slot. We put provenance
  // hints here that would be handy for debug panels and future
  // renderers — source channel (proxy/rollout/screen), message phase
  // (Codex commentary vs final_answer), tool_use_id for pair
  // matching. atp never reads this; it round-trips unchanged.
  const out: Record<string, unknown> = {}
  if (turn.source) out.source = turn.source
  if (block.messagePhase) out.messagePhase = block.messagePhase
  if (block.toolUseId) out.toolUseId = block.toolUseId
  if (block.callId) out.callId = block.callId
  return out
}

// -----------------------------------------------------------------------------
// Upstream → supersede (called from the JSONL ingest site)
// -----------------------------------------------------------------------------

/**
 * When an upstream authoritative entry lands, mark any ghost it
 * replaces as superseded. Matching is provider-aware:
 *
 *   Claude: upstream assistant entries carry a `message.id` that
 *           equals the turnId we used for the ghost. We therefore
 *           match by `turnId === message.id` and supersede EVERY
 *           ghost for that turn — a single upstream entry can
 *           authoritatively carry multiple content blocks, so one
 *           landing validates all provisional blocks for that turn.
 *
 *   Codex:  rollout emits one entry per content block with its own
 *           uuid. We match by (turnId, blockIndex). turnId for Codex
 *           comes from the response id when available; cc-shell's
 *           Codex ingest path already exposes it on the mapped
 *           entry. When the mapping is not available we fall back
 *           to tool_use id pairing for tool blocks.
 *
 *   Both:   if the upstream entry has a tool_use block whose id
 *           matches a ghost's `context.toolUseId`, supersede that
 *           specific ghost regardless of turn matching. This covers
 *           edge cases where the turn id doesn't line up (Codex
 *           rollout can mint fresh uuids on replay).
 *
 * The function is a no-op for non-conversation entries.
 */
export function reconcileUpstream(
  entry: Entry,
  prev: ReadonlyMap<string, GhostEntry>,
): Map<string, GhostEntry> {
  // Reference-stable no-ops: non-conversation entries and empty maps
  // return `prev` unchanged. Cloning here (the previous implementation
  // always returned `new Map(prev)`) made the JSONL ingest path
  // trigger a ghost-equality bust even when no supersede happened,
  // fighting the `ghostsChanged = nextGhosts !== current.ghosts`
  // short-circuit in the store.
  if (!isConversationEntry(entry)) return prev as Map<string, GhostEntry>
  if (prev.size === 0) return prev as Map<string, GhostEntry>

  const realUuid = entry.uuid ?? null
  if (!realUuid) return prev as Map<string, GhostEntry>

  const message = entry.message
  const messageId =
    typeof (message as { id?: string }).id === 'string'
      ? (message as { id: string }).id
      : null
  // Codex rollout-sourced entries don't carry message.id (the Codex
  // response id lives elsewhere on the rollout payload). Plumbing it
  // through the mapper to this matcher is Task 6 of the rendering-
  // fixes plan; the field is read defensively here so the match path
  // lights up the moment `mapCodexRolloutToFeedEntries` stamps it.
  const codexTurnId =
    typeof (entry as { codexTurnId?: string }).codexTurnId === 'string'
      ? (entry as { codexTurnId: string }).codexTurnId
      : null

  // Gather tool_use ids carried by this upstream entry — used for
  // the tool-use-id fallback match below.
  const toolUseIdsInEntry = new Set<string>()
  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      const rec = block as Record<string, unknown>
      if (rec?.type === 'tool_use' && typeof rec.id === 'string') {
        toolUseIdsInEntry.add(rec.id)
      }
    }
  }

  let next: Map<string, GhostEntry> | null = null
  for (const [uuid, ghost] of prev) {
    if (ghost._atp.supersededBy !== undefined) continue

    let match = false

    // Claude match by message.id → turnId equality.
    if (messageId && ghost._atp.turnId === messageId) match = true

    // Codex match by response id → turnId equality. Ghosts are minted
    // with `turnId = responseId` when the live source is Codex rollout,
    // so a committed entry carrying the same responseId supersedes
    // every ghost for that turn in one shot — matching the Claude
    // message.id contract.
    if (!match && codexTurnId && ghost._atp.turnId === codexTurnId) match = true

    // Shared: tool_use id equality. Works for both providers; wins
    // over message-id in ambiguous cases (the ghost knows the exact
    // tool_use_id it was minted from).
    if (!match) {
      const ctxToolId = ghost._atp.context?.toolUseId
      const ctxCallId = ghost._atp.context?.callId
      if (
        (typeof ctxToolId === 'string' && toolUseIdsInEntry.has(ctxToolId)) ||
        (typeof ctxCallId === 'string' && toolUseIdsInEntry.has(ctxCallId))
      ) {
        match = true
      }
    }

    if (!match) continue

    if (next === null) next = new Map(prev)
    next.set(uuid, supersedeGhost(ghost, realUuid))
  }

  return next ?? (prev as Map<string, GhostEntry>)
}

// -----------------------------------------------------------------------------
// Orphan stale (called from a periodic tick)
// -----------------------------------------------------------------------------

/**
 * Mark ghosts whose authoritative record never arrived as orphaned.
 * A ghost is considered stale when:
 *   - it is not yet superseded,
 *   - it is not already orphaned,
 *   - `updatedAt + ttlMs < now`.
 *
 * Orphaned ghosts stay in the map and still render — they're the
 * only record that the block ever existed. Consumers typically show
 * a visual "provisional" flag. Callers decide the TTL; 30 seconds is
 * a reasonable default for normal streaming (past that we're almost
 * certainly in a failure mode, not just batching latency).
 */
export function orphanStale(
  prev: ReadonlyMap<string, GhostEntry>,
  now: number,
  ttlMs: number,
): Map<string, GhostEntry> {
  if (prev.size === 0) return new Map(prev)
  const next = new Map(prev)
  for (const [uuid, ghost] of next) {
    if (ghost._atp.supersededBy !== undefined) continue
    if (ghost._atp.orphanedAt !== undefined) continue
    if (ghost._atp.updatedAt + ttlMs >= now) continue
    next.set(uuid, orphanGhostRecord(ghost, now))
  }
  return next
}

// -----------------------------------------------------------------------------
// Convenience: drop ghosts that were superseded more than a beat ago
// -----------------------------------------------------------------------------

/**
 * Once a ghost is superseded AND the upstream entry has been in
 * `runtime.entries` for at least `gcMs`, we can evict the ghost
 * from the map. Keeping superseded ghosts around indefinitely bloats
 * the runtime state and log payloads for no benefit — by the time
 * upstream has been visible for a couple of seconds, no renderer
 * still needs the ghost for transition smoothing.
 *
 * Called from the same periodic tick as `orphanStale`.
 */
export function gcSupersededGhosts(
  prev: ReadonlyMap<string, GhostEntry>,
  now: number,
  gcMs: number,
): Map<string, GhostEntry> {
  if (prev.size === 0) return new Map(prev)
  let changed = false
  const next = new Map(prev)
  for (const [uuid, ghost] of next) {
    if (ghost._atp.supersededBy === undefined) continue
    if (ghost._atp.updatedAt + gcMs >= now) continue
    next.delete(uuid)
    changed = true
  }
  return changed ? next : new Map(prev)
}

// -----------------------------------------------------------------------------
// Diff helper for persistence
// -----------------------------------------------------------------------------

/**
 * Return the ghosts that changed between `prev` and `next`.
 *
 * The ghost log on disk is append-only, and atp's `reduceGhostLog`
 * picks the freshest write per uuid. That means we only need to
 * persist ghosts whose `updatedAt` is newer than what disk already
 * has (or that disk has never seen). Snapshot diff by `updatedAt`
 * captures every meaningful transition:
 *   - new ghost created (prev missing)
 *   - content updated (updatedAt bumped)
 *   - superseded (updatedAt bumped by supersedeGhost)
 *   - orphaned (updatedAt bumped by orphanGhost)
 * without writing the whole map on every semantic tick.
 */
export function ghostsToPersist(
  prev: ReadonlyMap<string, GhostEntry>,
  next: ReadonlyMap<string, GhostEntry>,
): GhostEntry[] {
  if (prev === next) return []
  const out: GhostEntry[] = []
  for (const [uuid, ghost] of next) {
    const prior = prev.get(uuid)
    if (!prior) {
      out.push(ghost)
      continue
    }
    if (prior._atp.updatedAt !== ghost._atp.updatedAt) out.push(ghost)
  }
  return out
}
