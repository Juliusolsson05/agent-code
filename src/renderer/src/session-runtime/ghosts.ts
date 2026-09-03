// Renderer-side ghost reducer + the bridge between the live
// semantic stream, the durable JSONL transcript, and disk
// persistence.
//
// -----------------------------------------------------------------------------
// What ghost is in Agent Code today
// -----------------------------------------------------------------------------
//
// Ghost is a parallel disk-backed ledger of semantic events. As
// the proxy stream emits events, this file mints provisional
// `ClaudeEntry` records via atp's `createGhost`. When the
// authoritative JSONL entry lands (Claude's batched 100 ms drain;
// Codex's mpsc flush), `reconcileUpstream` matches by message.id /
// codexTurnId / tool_use_id and supersedes the ghost. If JSONL
// never matches (Claude Code's auxiliary calls — title gen,
// predict-next-prompt, branch-name gen — are not written to the
// rollout), `orphanStale` flags the ghost after the TTL.
//
// The live current turn renders via `SemanticStreamingTurn`
// directly off `runtime.semantic.currentTurn` — NOT through
// ghosts. So most ticks, the ghost map has no rendered output:
// the work this file does is bookkeeping (mint, reconcile,
// orphan, gc, persist) for two consumers:
//
//   1. `selectMergedEntries` (./mergedEntries.ts) — surfaces
//      orphan ghosts ONLY when JSONL has stalled past the proxy
//      (live-stuck mid-turn or resume-after-crash with partial
//      JSONL). The layered predicate there has the full design
//      rationale.
//
//   2. `ghostJournal.ts` (main process) — append-only JSONL log
//      under <userData>/ghost-logs/<sessionId>.ghost.jsonl.
//      Survives reload / restart so the JSONL-stuck case can
//      recover the lost partial turn on resume via the bootstrap
//      merge in src/renderer/src/workspace/hook/actions/session.ts.
//
// -----------------------------------------------------------------------------
// Provider-aware reconciliation
// -----------------------------------------------------------------------------
//
// Claude: upstream assistant entries carry `message.id == turnId`,
// so one upstream entry supersedes every ghost block for that
// turn at once.
//
// Codex: rollout emits one entry per content block, with the
// rollout response_id stamped onto the mapped entry by
// `stampCodexTurnId` in ../codex/rollout.ts. Match is by
// (turnId, blockIndex). When that fails, both providers fall back
// to tool_use_id / call_id pairing for tool blocks.
//
// -----------------------------------------------------------------------------
// Reference stability
// -----------------------------------------------------------------------------
//
// Every reducer below MUST return `prev` unchanged on no-op so
// React memoization holds at the call site. This isn't an
// optimization — it's load-bearing. The pre-fix versions always
// allocated `new Map(prev)` at the top, which made
// `nextGhosts !== current.ghosts` always true downstream, forcing
// a setRuntimes cascade that busted every useMemo([entries]) in
// Feed via selectMergedEntries.
//
// See docs/design/ghost-system.md for the canonical explanation
// of the ghost subsystem — what it does, the five-rule render
// predicate, and the load-bearing invariants this file must
// uphold. DO NOT change the lifecycle, reconciliation, or
// reference-stability behavior here without re-reading that doc.
//
// See also `agent-transcript-parser/docs/ghost.md` for the
// underlying primitive's semantics, and
// docs/superpowers/plans/2026-05-07-ghost-system-findings.md for
// the long-form diagnostic of how Agent Code got here.
//
// No function here performs IO. No function here subscribes to
// events. Input goes in, new `Map<uuid, GhostEntry>` comes out.

import {
  createGhost,
  ghostUuid,
  orphanGhost as orphanGhostRecord,
  supersedeGhost,
  updateGhost,
} from 'agent-transcript-parser/ghost'
import type {
  ClaudeContentBlock,
  ClaudeToolUseBlock,
  ClaudeTextBlock,
  ClaudeThinkingBlock,
  GhostEntry,
} from 'agent-transcript-parser/ghost'

import type { Entry } from '@shared/types/transcript'
import { isConversationEntry } from '@shared/types/transcript'
import { asRecord } from '@shared/lib/asRecord'
import type {
  SemanticLiveBlock,
  SemanticLiveTurn,
} from '@renderer/session-runtime/state'

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

  // Compaction-synthesis turns stream raw `<analysis>...</analysis>
  // <summary>...</summary>` XML that the renderer hides behind a
  // "Compacting conversation…" placeholder (StreamingTurn handles it,
  // foldEvent propagates the flag — see PR #74). But the GHOST log
  // is a separate, durable on-disk record under
  // `<userData>/ghost-logs/` that exists so we can recover proxy
  // content when the provider JSONL hangs behind. Without this
  // short-circuit, every /compact run accumulates the raw XML in
  // that JSONL — invisible in the UI, but it bloats the file and
  // makes debug bundles harder to read.
  //
  // We fail-closed: the predicate is `=== true`, so unknown/Codex
  // turns where the flag is undefined still flow through the normal
  // ghost path. The 30s orphan-ghost window in mergedEntries.ts
  // would otherwise re-surface raw synthesis content if JSONL
  // writes are delayed past that window — suppressing creation here
  // is the only place that closes that gap completely.
  if (turn.isCompactionSynthesis === true) return prev as Map<string, GhostEntry>

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
 *           comes from the response id when available; Agent Code's
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
  const messageRecord = asRecord(message)
  const messageId =
    typeof messageRecord?.id === 'string'
      ? messageRecord.id
      : null
  // Codex rollout-sourced entries don't carry message.id (the Codex
  // response id lives elsewhere on the rollout payload). Plumbing it
  // through the mapper to this matcher is Task 6 of the rendering-
  // fixes plan; the field is read defensively here so the match path
  // lights up the moment `mapCodexRolloutToFeedEntries` stamps it.
  const codexRecord = asRecord(entry)
  const codexTurnId =
    typeof codexRecord?.codexTurnId === 'string'
      ? codexRecord.codexTurnId
      : null

  // Gather tool_use ids carried by this upstream entry — used for
  // the tool-use-id fallback match below.
  const toolUseIdsInEntry = new Set<string>()
  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      const rec = asRecord(block)
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
  if (prev.size === 0) return prev as Map<string, GhostEntry>
  let next: Map<string, GhostEntry> | null = null
  for (const [uuid, ghost] of prev) {
    if (ghost._atp.supersededBy !== undefined) continue
    if (ghost._atp.orphanedAt !== undefined) continue
    if (ghost._atp.updatedAt + ttlMs >= now) continue
    if (next === null) next = new Map(prev)
    next.set(uuid, orphanGhostRecord(ghost, now))
  }
  return next ?? (prev as Map<string, GhostEntry>)
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
  if (prev.size === 0) return prev as Map<string, GhostEntry>
  let next: Map<string, GhostEntry> | null = null
  for (const [uuid, ghost] of prev) {
    if (ghost._atp.supersededBy === undefined) continue
    if (ghost._atp.updatedAt + gcMs >= now) continue
    if (next === null) next = new Map(prev)
    next.delete(uuid)
  }
  return next ?? (prev as Map<string, GhostEntry>)
}

// -----------------------------------------------------------------------------
// Hidden orphans: rule 4 of the render predicate, shared with the trim bound
// -----------------------------------------------------------------------------

/**
 * An orphaned ghost at-or-before the committed JSONL tail can never paint
 * again: the render predicate's rule 4 (rendering/model/ghostPredicate.ts,
 * mirrored in mergedEntries.ts) hides it, and `lastJsonlEntryAt` only moves
 * forward (every writer max-merges; every reset also resets the ghost map).
 *
 * WHY this lives here and is shared (#724): two consumers besides the
 * predicate need the same answer — `computeProtectBound` in
 * liveEntryWindow.ts (such a ghost must not pin the live-entry trim bound)
 * and `gcHiddenOrphanGhosts` below (such a ghost need not stay in memory).
 * One function keeps the three from drifting.
 *
 * A null tail (no JSONL observed yet) is never "hidden": the conservative
 * pre-#724 behaviour stands. Mixed-clock caveat exactly as for rule 4 —
 * renderer wall-clock `updatedAt` against a producer JSONL timestamp, the
 * established convention of this subsystem.
 */
export function isGhostHiddenBehindJsonlTail(
  ghost: GhostEntry,
  lastJsonlEntryAt: number | null,
): boolean {
  return (
    ghost._atp.orphanedAt !== undefined &&
    lastJsonlEntryAt !== null &&
    ghost._atp.updatedAt <= lastJsonlEntryAt
  )
}

/**
 * Evict orphaned, un-superseded ghosts the committed tail has already passed
 * (see isGhostHiddenBehindJsonlTail) once they have been orphaned for at
 * least `gcMs` — except ghosts of the live `currentTurn`.
 *
 * WHY these can go (#724): rule 4 hides exactly this set for good. Keeping
 * them bought nothing and cost two things: `runtime.ghosts` grew
 * monotonically (917 ghosts in one session on the two-day journal), and
 * every un-superseded ghost pins the live-entry trim bound, so the first
 * never-matched orphan froze `planLiveEntryTrim` for the rest of the session.
 *
 * WHY the live turn's ghosts are exempt: `ghostsFromSemanticTurn` re-mints
 * any block of `semantic.currentTurn` whose uuid is missing from the map, on
 * every semantic tick. Evicting a hidden orphan of a turn that is still
 * current (a tool running past the orphan TTL, or a reconcile miss) would
 * therefore re-create it un-orphaned with a fresh `updatedAt` — churn on
 * every tick, and a reset of rule 4's clock that could let it paint later
 * as a duplicate. Those ghosts wait until the turn is no longer current;
 * `currentTurn.startedAt` already protects the trim bound meanwhile.
 *
 * WHY orphans NEWER than the tail stay: that is the "JSONL stuck past live"
 * fallback the ghost system exists for — they may still render and their
 * committed owners must stay protected. A null tail keeps everything.
 *
 * WHY a grace period: the orphan transition is what persists the ghost to
 * the on-disk log (`ghostsToPersist` diffs by `updatedAt`); waiting `gcMs`
 * after `orphanedAt` gives that append the same head start superseded ghosts
 * get before `gcSupersededGhosts` drops them. Nothing durable is lost — on
 * resume the ghost is reloaded, hidden by the same rule, and swept again.
 *
 * Reference-stable on no-op, like every other reducer in this file.
 */
export function gcHiddenOrphanGhosts(
  prev: ReadonlyMap<string, GhostEntry>,
  lastJsonlEntryAt: number | null,
  currentTurnId: string | null,
  now: number,
  gcMs: number,
): Map<string, GhostEntry> {
  if (prev.size === 0 || lastJsonlEntryAt === null) return prev as Map<string, GhostEntry>
  let next: Map<string, GhostEntry> | null = null
  for (const [uuid, ghost] of prev) {
    if (ghost._atp.supersededBy !== undefined) continue
    const orphanedAt = ghost._atp.orphanedAt
    if (orphanedAt === undefined) continue
    if (!isGhostHiddenBehindJsonlTail(ghost, lastJsonlEntryAt)) continue
    if (currentTurnId !== null && ghost._atp.turnId === currentTurnId) continue
    if (orphanedAt + gcMs >= now) continue
    if (next === null) next = new Map(prev)
    next.delete(uuid)
  }
  return next ?? (prev as Map<string, GhostEntry>)
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
