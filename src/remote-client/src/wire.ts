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

export type RemoteSessionSummary = {
  sessionId: string
  kind: string
  cwd: string | null
  alive: boolean
}

export type FeedChannel =
  | 'started'
  | 'screen'
  | 'jsonl-entries'
  | 'jsonl-error'
  | 'semantic-event'
  | 'conditions'
  | 'process-state'
  | 'exit'
  | 'removed'

export type OutboundFrame =
  | { type: 'hello'; deviceId: string; deviceName: string }
  | { type: 'session-list'; sessions: RemoteSessionSummary[] }
  | { type: 'session-event'; channel: FeedChannel; payload: unknown }
  | { type: 'reply'; id?: string; ok: boolean; error?: string; result?: unknown }
  | { type: 'error'; error: string }

export type InboundMessage =
  | { type: 'ping' }
  | { type: 'send-prompt'; sessionId: string; text: string }
  | { type: 'submit'; sessionId: string }
  | { type: 'interrupt'; sessionId: string }
  | {
      type: 'permission-reply'
      sessionId: string
      action:
        | { kind: 'pty'; id: string; label: string; data: string }
        | { kind: 'custom'; id: string; label: string; name: string; payload?: unknown }
    }

export type InboundFrame = {
  token: string
  id?: string
  message: InboundMessage
}
