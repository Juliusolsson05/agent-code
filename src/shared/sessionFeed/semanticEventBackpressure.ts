import { asRecord } from '@shared/lib/asRecord'
import type { SessionSemanticEvent } from '@shared/sessionFeed/types'

/**
 * Provider semantic transports deliberately publish running accumulators for streaming events.
 * That contract lets every transport layer skip obsolete intermediate snapshots without losing
 * user-visible text or tool input. This module is shared by main and renderer because coalescing
 * only in renderer still makes Chromium deserialize every raw provider delta first.
 *
 * Keep this list narrow. Structural events are ordering barriers and must be forwarded
 * synchronously. A future event belongs here only when it carries an authoritative "so far" value
 * or its fragments can be losslessly concatenated for one semantic owner.
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
  return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}

function coalescingKey(message: SessionSemanticEvent): string | null {
  const event = asRecord(message.event)
  const type = typeof event?.type === 'string' ? event.type : ''
  if (!event || !COALESCIBLE_EVENT_TYPES.has(type)) return null

  // WHY all available identities participate: providers disagree on one block key. Omitting any
  // dimension can make one stream overwrite an unrelated sibling even though each event family is
  // independently safe to coalesce.
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

  // OpenCode names the cumulative contract `fullText` / `fullInput`, while the shared fold consumes
  // the Claude/Codex `*SoFar` names. Canonicalize even a one-event window so moving this queue
  // across the IPC boundary cannot change provider semantics.
  if (
    record.type === 'text_delta' &&
    typeof record.fullText === 'string' &&
    typeof record.textSoFar !== 'string'
  ) return { ...record, textSoFar: record.fullText }
  if (
    record.type === 'thinking_delta' &&
    typeof record.fullText === 'string' &&
    typeof record.thinkingSoFar !== 'string'
  ) return { ...record, thinkingSoFar: record.fullText }
  if (
    record.type === 'tool_input_delta' &&
    typeof record.fullInput === 'string' &&
    typeof record.inputJsonSoFar !== 'string'
  ) return { ...record, inputJsonSoFar: record.fullInput }
  return event
}

function mergeEvents(previous: unknown, next: unknown): unknown {
  const canonicalNext = canonicalizeAccumulator(next)
  const previousEvent = asRecord(previous)
  const nextEvent = asRecord(canonicalNext)
  if (!previousEvent || !nextEvent || previousEvent.type !== nextEvent.type) return canonicalNext

  const hasAuthoritativeAccumulator =
    typeof nextEvent.textSoFar === 'string' ||
    typeof nextEvent.thinkingSoFar === 'string' ||
    typeof nextEvent.connectorTextSoFar === 'string' ||
    Array.isArray(nextEvent.citationsSoFar) ||
    typeof nextEvent.inputJsonSoFar === 'string' ||
    (nextEvent.type === 'turn_delta' && typeof nextEvent.fullText === 'string')
  if (hasAuthoritativeAccumulator) return canonicalNext

  // Compatibility streams can still publish fragments. Structural events never enter this queue,
  // so adjacent fragments for the same identity can be joined without crossing a completion/error
  // boundary.
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
      return canonicalNext
  }
}

function representedEventCount(message: SessionSemanticEvent): number {
  return Number.isSafeInteger(message.rawEventCount) && (message.rawEventCount ?? 0) > 0
    ? message.rawEventCount!
    : 1
}

/** Scheduler-agnostic bounded queue shared by main IPC and renderer state folding. */
export class SemanticEventBackpressureQueue {
  private pending: CoalescedSemanticEvent[] = []
  private latestIndexByKey = new Map<string, number>()

  /** Returns false for structural events, which callers must forward after draining the queue. */
  tryPush(message: SessionSemanticEvent): boolean {
    const key = coalescingKey(message)
    if (key === null) return false

    const incomingCount = representedEventCount(message)
    const existingIndex = this.latestIndexByKey.get(key)
    if (existingIndex !== undefined) {
      const existing = this.pending[existingIndex]
      this.pending[existingIndex] = {
        message: {
          sessionId: message.sessionId,
          event: mergeEvents(existing?.message.event, message.event),
        },
        rawEventCount: (existing?.rawEventCount ?? 0) + incomingCount,
      }
      return true
    }

    this.latestIndexByKey.set(key, this.pending.length)
    this.pending.push({
      message: {
        sessionId: message.sessionId,
        event: canonicalizeAccumulator(message.event),
      },
      rawEventCount: incomingCount,
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
