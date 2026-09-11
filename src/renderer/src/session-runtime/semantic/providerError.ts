import type { SemanticErrorEntry } from '@renderer/session-runtime/state'

/** Retain a bounded set of status facts independently of semantic turns. HTTP
 * refusal happens before response.created, so forcing it into currentTurn would
 * either hide the error or fabricate an assistant answer. Request identity is
 * scoped to the actual run; unscoped old events use their recorded timestamp as
 * an additional discriminator, never as the identity of unrelated attempts. */
export function retainProviderError(
  event: Record<string, unknown>,
  kind: SemanticErrorEntry['kind'],
  sequence: number,
  receivedAt: number,
  sessionRunId?: string | null,
): SemanticErrorEntry {
  const string = (key: string): string | undefined => typeof event[key] === 'string' && event[key].length > 0 ? event[key] : undefined
  const number = (key: string): number | undefined => typeof event[key] === 'number' && Number.isFinite(event[key]) ? event[key] : undefined
  const requestId = string('requestId')
  const source = string('source')
  const observedAtMs = number('ts')
  const validObservedAt = observedAtMs !== undefined && observedAtMs >= 1_000_000_000_000 && observedAtMs <= 8_640_000_000_000_000 ? observedAtMs : undefined
  return {
    id: requestId ? `request:${JSON.stringify([sessionRunId ?? validObservedAt ?? null, source, kind, requestId])}` : `error:${sequence}`,
    kind, ts: validObservedAt ?? receivedAt,
    // A legacy record without producer time keeps a debug receipt time, but
    // cannot invent a chronological place in a historical replay.
    observedAtMs: validObservedAt,
    message: typeof event.message === 'string' ? event.message : '(no message)',
    requestId, source, sessionRunId: sessionRunId ?? undefined,
    errorType: string('errorType'), turnId: string('turnId'),
    resetsAt: number('resetsAt'), limitId: string('limitId'), limitName: string('limitName'),
    rateLimitReachedType: string('rateLimitReachedType'),
    status: number('status'), retryAfterMs: number('retryAfterMs'),
  }
}
