import type { SessionBackendSnapshot } from '@shared/types/session'
import type { SessionId, SessionMeta } from '@renderer/workspace/types'

export type SessionRecoveryOutcome =
  | {
      status: 'live'
      meta: SessionMeta
      snapshot: SessionBackendSnapshot
    }
  | {
      status: 'failed'
      meta: SessionMeta
      message: string
    }

export type RecoveryProjection = {
  idMap: Map<SessionId, SessionId>
  sessions: Record<SessionId, SessionMeta>
  resolvedIds: Set<SessionId>
  liveBackendIds: Set<SessionId>
  failures: Map<SessionId, string>
  backendSnapshots: Map<SessionId, SessionBackendSnapshot>
}

/**
 * Purely project durable ownership plus resolved backend outcomes into the
 * renderer state that is safe to publish and autosave.
 *
 * WHY failures count as resolved: restore completion answers "has every
 * visible leaf received an honest outcome?", not "did every provider start?".
 * Dropping a failed leaf or holding autosave off forever both destroy more user
 * state than the provider failure itself. Hibernated sessions are metadata-only
 * by design and therefore survive without an outcome or backend.
 */
export function projectSessionRecovery(input: {
  persistedSessions: Record<SessionId, SessionMeta>
  ownedIds: ReadonlySet<SessionId>
  liveProcessIds: ReadonlySet<SessionId>
  outcomes: ReadonlyMap<SessionId, SessionRecoveryOutcome>
}): RecoveryProjection {
  const projection: RecoveryProjection = {
    idMap: new Map(),
    sessions: {},
    resolvedIds: new Set(),
    liveBackendIds: new Set(),
    failures: new Map(),
    backendSnapshots: new Map(),
  }

  for (const [sessionId, persistedMeta] of Object.entries(input.persistedSessions)) {
    if (!input.ownedIds.has(sessionId)) continue
    if (!input.liveProcessIds.has(sessionId)) {
      projection.sessions[sessionId] = persistedMeta
      continue
    }
    const outcome = input.outcomes.get(sessionId)
    if (!outcome) continue

    // Recovery preserves the app-local routing id. Keeping an explicit
    // identity mapping lets the still-remap-shaped relationship/layout code
    // converge without reintroducing fresh-id allocation.
    projection.idMap.set(sessionId, sessionId)
    projection.sessions[sessionId] = outcome.meta
    projection.resolvedIds.add(sessionId)
    if (outcome.status === 'live') {
      projection.liveBackendIds.add(sessionId)
      projection.backendSnapshots.set(sessionId, outcome.snapshot)
    } else {
      projection.failures.set(sessionId, outcome.message)
    }
  }

  return projection
}
