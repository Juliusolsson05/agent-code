import type { SemanticEvent } from 'opencode-headless'

// OpenCode semantic vocabulary alignment (remote-v2 rebuild, M3).
//
// WHY THIS MODULE EXISTS: opencode-headless publishes block events keyed by
// `blockId` (the part/call id) and NEVER sets a numeric `blockIndex`, while
// the shared renderer fold (`session-runtime/semantic/foldEvent.ts`)
// requires `ev.blockIndex` on every block event and silently DROPS the
// event when `semanticToIndex` returns null (foldEvent.ts:465 etc.). Net
// effect before this mapping: during a live structured-OpenCode turn, tool
// blocks, thinking, and live tool input never folded — on desktop AND
// phone — and the turn painted only turn-level answer text until the
// committed entry landed.
//
// WHY THE ADAPTER BOUNDARY AND NOT THE PACKAGE: the package's channel
// contract is "block events are keyed by blockId" and other consumers may
// rely on that shape; inventing authoritative index numbers inside the
// dispatcher would change the package's public vocabulary for every
// consumer at once. The app-side adapter owns the translation to the
// FOLD's vocabulary (blockIndex + textSoFar/inputJsonSoFar/parsed field
// names), exactly where Claude/Codex already speak it. One place, one
// direction.
//
// Index assignment: stable per (turnId, blockId) pair, in first-seen
// order — the same rule an insertion-ordered array would give. Reset
// bookkeeping per turn; keep a small bounded window of past turns because
// late events (a result arriving after the next turn started) must still
// map to their original index.

const MAX_TRACKED_TURNS = 8

export class OpenCodeBlockIndexTracker {
  private turns = new Map<string, Map<string, number>>()

  indexFor(turnId: string, blockId: string): number {
    let blocks = this.turns.get(turnId)
    if (!blocks) {
      // Bound the tracker: evict the OLDEST turn entry. A turn's blocks are
      // folded by the time several newer turns exist; retaining all of them
      // would grow with conversation length for no consumer.
      if (this.turns.size >= MAX_TRACKED_TURNS) {
        const oldest = this.turns.keys().next().value
        if (typeof oldest === 'string') this.turns.delete(oldest)
      }
      blocks = new Map()
      this.turns.set(turnId, blocks)
    }
    const existing = blocks.get(blockId)
    if (existing !== undefined) return existing
    const next = blocks.size
    blocks.set(blockId, next)
    return next
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Translate one opencode-headless semantic event onto the fold's vocabulary.
 * Non-block events pass through untouched (same reference — identity
 * stability is a fold invariant, not an optimization).
 */
export function mapOpenCodeSemanticEvent(
  ev: SemanticEvent,
  tracker: OpenCodeBlockIndexTracker,
): unknown {
  const blockId = (ev as { blockId?: unknown }).blockId
  const turnId = (ev as { turnId?: unknown }).turnId
  if (typeof blockId !== 'string' || typeof turnId !== 'string') return ev
  const blockIndex = tracker.indexFor(turnId, blockId)

  switch (ev.type) {
    case 'block_started':
    case 'block_completed': {
      // toolUseId = blockId: the package's tool_result events key by the
      // same part/call id, and the fold's result pairing matches
      // block.toolUseId === ev.toolUseId — aligning them here is what makes
      // live results land on their originating blocks.
      return {
        ...ev,
        blockIndex,
        toolName: ev.name,
        toolUseId: blockId,
      }
    }
    case 'text_delta':
      return { ...ev, blockIndex, textSoFar: ev.fullText }
    case 'thinking_delta':
      return { ...ev, blockIndex, thinkingDelta: ev.textDelta, thinkingSoFar: ev.fullText }
    case 'tool_input_delta':
      return {
        ...ev,
        blockIndex,
        partialJson: ev.inputDelta,
        inputJsonSoFar: ev.fullInput,
        toolName: ev.name,
        toolUseId: blockId,
      }
    case 'tool_input_finalized': {
      // The package carries the parsed input as `input` (object or string);
      // the fold wants BOTH the JSON text (inputJson) and the record
      // (parsed). inputJsonValid is derived from parsed presence, matching
      // the fold's `Boolean(ev.parsed)`.
      const inputJson =
        typeof ev.input === 'string' ? ev.input : JSON.stringify(ev.input ?? null)
      return {
        ...ev,
        blockIndex,
        inputJson,
        parsed: isRecord(ev.input) ? ev.input : undefined,
        toolName: ev.name,
        toolUseId: blockId,
      }
    }
    default:
      // tool_result / turn lifecycle / usage / errors carry no blockId —
      // unreachable for events that got past the blockId guard, but kept
      // total so a future package event type with a blockId still passes
      // through enriched with its index rather than being dropped.
      return { ...ev, blockIndex }
  }
}
