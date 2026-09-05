// Client-side mirror of the remote wire protocol.
//
// Deliberately re-declared rather than imported from
// src/main/remote/protocol/messages.ts: that module lives in the node
// tsconfig project (NodeNext, zod runtime) and pulling it into the phone
// bundle would drag zod plus main-side import conventions across the
// build boundary for what is, on this side, pure type description — the
// client VALIDATES nothing (the server is the trust boundary and validates
// every inbound frame; frames the server sends are trusted by
// construction). Same duplication discipline the preload bridge uses for
// RemoteStatus. If a field changes shape, the client<->server integration
// test (WebSocketSessionFeed.integration.test.ts) is what catches drift.
import type { PromptDeliveryResult } from '@shared/types/providerConfig'

export type RemoteSessionSummary = {
  sessionId: string
  kind: string
  cwd: string | null
  alive: boolean
  /** Epoch ms of last observed activity — picker sort key. Server-stamped
   *  at list time; the client bumps it locally from live session events. */
  lastActivityAt: number | null
}

export type FeedChannel =
  | 'started'
  | 'input-readiness'
  | 'screen'
  | 'jsonl-entries'
  | 'jsonl-error'
  | 'semantic-event'
  | 'conditions'
  | 'process-state'
  | 'exit'
  | 'removed'

export type OutboundFrame =
  | {
      type: 'hello'
      deviceId: string
      deviceName: string
      themeSettings?: Record<string, unknown> | null
      /** Server-side STT capability (transcriber wired AND key present) so
       *  the mic can be disabled BEFORE recording instead of failing after
       *  upload with a 503. Optional: an older server doesn't send it, and
       *  absence means "unknown → keep the mic enabled" (the pre-capability
       *  fail-at-upload behavior). Mirror of protocol/messages.ts — see its
       *  WHY comment for the per-connection evaluation semantics. */
      sttAvailable?: boolean
    }
  | { type: 'theme-settings'; themeSettings: Record<string, unknown> | null }
  | { type: 'session-list'; sessions: RemoteSessionSummary[] }
  | { type: 'session-event'; channel: FeedChannel; payload: unknown }
  | {
      type: 'reply'
      id?: string
      ok: boolean
      error?: string
      result?: unknown
      delivery?: PromptDeliveryResult
    }
  | { type: 'error'; error: string }

export type InboundMessage =
  | { type: 'ping' }
  | { type: 'send-prompt'; sessionId: string; text: string }
  | { type: 'submit'; sessionId: string }
  | { type: 'interrupt'; sessionId: string }
  | {
      type: 'get-history'
      sessionId: string
      beforeMarker?: string
      /** Byte offset of beforeMarker's line (from a chunk's `offsets`); the
       *  server anchors the page exactly there when present. */
      beforeOffset?: number
      limit?: number
    }
  | {
      type: 'permission-reply'
      sessionId: string
      action:
        | { kind: 'pty'; id: string; label: string; data: string }
        | { kind: 'custom'; id: string; label: string; name: string; payload?: unknown }
    }

/** Reply payload for get-history: raw transcript records in the same shape
 *  as live jsonl frames' `entry` halves — one mapper path serves both. */
export type HistoryChunkResult = {
  entries: Array<Record<string, unknown>>
  hasMore: boolean
  totalEntries?: number
  /** Byte offset of each entry's transcript line, parallel to `entries`;
   *  echo the cursor line's offset as `beforeOffset` for an exact next
   *  page. The client's store does not use it yet and pages on the marker
   *  alone (the server's forward scan, as before). */
  offsets?: number[]
  /** Which transcript file the server read. The client compares this
   *  against the file its live frames carry to detect a stale serve from
   *  the post-/clear cache window — see TranscriptStore.chunkFileConflicts. */
  file?: string
}

export type InboundFrame = {
  token: string
  id?: string
  message: InboundMessage
}
