import type { SessionSemanticEvent } from '@shared/sessionFeed/types'
import { asRecord } from '@shared/lib/asRecord'

/**
 * The semantic transports deliberately publish running accumulators for the
 * renderer-facing streaming events. That contract is more than a recovery
 * convenience: it lets the UI skip obsolete intermediate snapshots without
 * losing any user-visible text or tool input.
 *
 * Keep this list narrow. Structural events are ordering barriers and must be
 * folded synchronously by the subscription hub. A future event only belongs
 * here when either (a) it carries an authoritative "so far" value or (b) its
 * delta field can be losslessly concatenated with adjacent events for the same
 * semantic owner.
 */
const COALESCIBLE_EVENT_TYPES = new Set([
  'turn_delta',
  'text_delta',
  'thinking_delta',
  'connector_text_delta',
  'citations_delta',
  'signature',
  'tool_input_delta',
  'tool_output_delta',
  'usage_updated',
])

export type CoalescedSemanticEvent = {
  message: SessionSemanticEvent
  /** Number of provider events represented by `message`. */
  rawEventCount: number
}

function identityPart(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : ''
}

function coalescingKey(message: SessionSemanticEvent): string | null {
  const event = asRecord(message.event)
  const type = typeof event?.type === 'string' ? event.type : ''
  if (!event || !COALESCIBLE_EVENT_TYPES.has(type)) return null

  // WHY all available identities participate in the key: providers do not
  // agree on one block key. Claude/Codex primarily use blockIndex, OpenCode
  // can use blockId, Codex thinking has independent tracks, and tool output is
  // callId-owned rather than block-owned. Collapsing any of those dimensions
  // can make one stream overwrite an unrelated sibling even though both
  // individual events are safe to coalesce.
  return [
    message.sessionId,
    type,
    identityPart(event.turnId),
    identityPart(event.blockIndex),
    identityPart(event.blockId),
    identityPart(event.track),
    identityPart(event.index),
    identityPart(event.callId),
    identityPart(event.toolUseId),
  ].join('\u001f')
}

function joinDelta(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
  field: string,
): string | undefined {
  const left = previous[field]
  const right = next[field]
  if (typeof left !== 'string' && typeof right !== 'string') return undefined
  return `${typeof left === 'string' ? left : ''}${typeof right === 'string' ? right : ''}`
}

function canonicalizeAccumulator(event: unknown): unknown {
  const record = asRecord(event)
  if (!record) return event

  // OpenCode names the same cumulative contract `fullText` / `fullInput`,
  // while the shared renderer fold historically consumes the Claude/Codex
  // `*SoFar` names. Canonicalize every queued event—even a window containing a
  // single delta—so the fold always sees the authoritative accumulator instead
  // of appending or ignoring one provider-specific fragment.
  if (
    record.type === 'text_delta' &&
    typeof record.fullText === 'string' &&
    typeof record.textSoFar !== 'string'
  ) {
    return { ...record, textSoFar: record.fullText }
  }
  if (
    record.type === 'thinking_delta' &&
    typeof record.fullText === 'string' &&
    typeof record.thinkingSoFar !== 'string'
  ) {
    return { ...record, thinkingSoFar: record.fullText }
  }
  if (
    record.type === 'tool_input_delta' &&
    typeof record.fullInput === 'string' &&
    typeof record.inputJsonSoFar !== 'string'
  ) {
    return { ...record, inputJsonSoFar: record.fullInput }
  }
  return event
}

function mergeEvents(previous: unknown, next: unknown): unknown {
  const canonicalNext = canonicalizeAccumulator(next)
  const previousEvent = asRecord(previous)
  const nextEvent = asRecord(canonicalNext)
  if (!previousEvent || !nextEvent || previousEvent.type !== nextEvent.type) {
    return canonicalNext
  }

  // Prefer a provider's cumulative value whenever one exists. The reducer
  // already treats these fields as authoritative, so retaining only the latest
  // object produces exactly the same final state as folding every prefix.
  const hasAuthoritativeAccumulator =
    typeof nextEvent.textSoFar === 'string' ||
    typeof nextEvent.thinkingSoFar === 'string' ||
    typeof nextEvent.connectorTextSoFar === 'string' ||
    Array.isArray(nextEvent.citationsSoFar) ||
    typeof nextEvent.inputJsonSoFar === 'string' ||
    (nextEvent.type === 'turn_delta' && typeof nextEvent.fullText === 'string')
  if (hasAuthoritativeAccumulator) return canonicalNext

  // A few compatibility streams still publish fragment-only events. Adjacent
  // fragments are safe to concatenate because structural events never enter
  // this queue: the subscription hub flushes before folding block completion,
  // turn completion, errors, or any other ordering boundary.
  switch (nextEvent.type) {
    case 'text_delta': {
      const textDelta = joinDelta(previousEvent, nextEvent, 'textDelta')
      return textDelta === undefined ? canonicalNext : { ...nextEvent, textDelta }
    }
    case 'thinking_delta': {
      const thinkingDelta = joinDelta(previousEvent, nextEvent, 'thinkingDelta')
      const textDelta = joinDelta(previousEvent, nextEvent, 'textDelta')
      return {
        ...nextEvent,
        ...(thinkingDelta === undefined ? {} : { thinkingDelta }),
        ...(textDelta === undefined ? {} : { textDelta }),
      }
    }
    case 'connector_text_delta': {
      const connectorTextDelta = joinDelta(previousEvent, nextEvent, 'connectorTextDelta')
      return connectorTextDelta === undefined
        ? canonicalNext
        : { ...nextEvent, connectorTextDelta }
    }
    case 'tool_input_delta': {
      const partialJson = joinDelta(previousEvent, nextEvent, 'partialJson')
      const inputDelta = joinDelta(previousEvent, nextEvent, 'inputDelta')
      return {
        ...nextEvent,
        ...(partialJson === undefined ? {} : { partialJson }),
        ...(inputDelta === undefined ? {} : { inputDelta }),
      }
    }
    case 'tool_output_delta': {
      const textDelta = joinDelta(previousEvent, nextEvent, 'textDelta')
      return textDelta === undefined ? canonicalNext : { ...nextEvent, textDelta }
    }
    default:
      // signature, usage_updated, and cumulative-only event families replace
      // atomically. Their latest snapshot is the only state the UI consumes.
      return canonicalNext
  }
}

/**
 * Bounded-work queue for renderer semantic deltas.
 *
 * The queue is intentionally scheduler-agnostic. The hook owns the cadence and
 * structural-event flush boundary, while this class owns the provider-shape
 * compatibility and stable ordering. Separating those responsibilities gives
 * the hot-path policy deterministic unit coverage without React timers.
 */
export class SemanticEventBackpressureQueue {
  private pending: CoalescedSemanticEvent[] = []
  private latestIndexByKey = new Map<string, number>()

  /** Returns false for structural events, which callers must fold directly. */
  tryPush(message: SessionSemanticEvent): boolean {
    const key = coalescingKey(message)
    if (key === null) return false

    const existingIndex = this.latestIndexByKey.get(key)
    if (existingIndex !== undefined) {
      const existing = this.pending[existingIndex]
      this.pending[existingIndex] = {
        message: {
          sessionId: message.sessionId,
          event: mergeEvents(existing?.message.event, message.event),
        },
        rawEventCount: (existing?.rawEventCount ?? 0) + 1,
      }
      return true
    }

    this.latestIndexByKey.set(key, this.pending.length)
    this.pending.push({
      message: {
        sessionId: message.sessionId,
        event: canonicalizeAccumulator(message.event),
      },
      rawEventCount: 1,
    })
    return true
  }

  drain(): CoalescedSemanticEvent[] {
    const drained = this.pending
    this.pending = []
    this.latestIndexByKey.clear()
    return drained
  }

  get size(): number {
    return this.pending.length
  }
}
