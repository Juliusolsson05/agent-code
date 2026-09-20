import type { AgentProviderKind } from './providerKind.js'
import type { SessionHistoryChunk } from './session.js'

export type SessionRoutingGapReason =
  | 'unowned'
  | 'owner_replaced'
  | 'renderer_replaced'
  | 'queue_limit'
  | 'queue_expired'
  | 'unsupported_payload'
  | 'delivery_failed'
  | 'metadata_evicted'

export type SessionRoutingGap = {
  sessionId: string
  ownershipRevision: number
  gapRevision: number
  reason: SessionRoutingGapReason
  missedEvents: number
}

/** Desktop display ownership only; this is not permission to start or write. */
export type SessionRoutingScope = Pick<SessionRoutingGap, 'sessionId' | 'ownershipRevision' | 'gapRevision'>

export type SessionRoutingResyncResult =
  | { kind: 'stale' | 'unavailable' }
  | {
      kind: 'seeded'
      sessionRunId: string | null
      history: { sourceKey: string; kind: AgentProviderKind; cwd: string; providerSessionId: string } | null
    }

export type SessionRoutingHistoryResult =
  | { kind: 'stale' | 'unavailable' }
  | { kind: 'loaded'; chunk: SessionHistoryChunk }
