import type { SessionFeed } from '@shared/sessionFeed/SessionFeed'
import type { SessionHistoryBoundaryEvent } from '@shared/sessionFeed/types'

// The desktop implementation of SessionFeed: a pure pass-through to the flat
// `window.api` preload bridge (see src/preload/api/index.ts for why the
// surface is flat).
//
// WHY this exists at all when it adds nothing over calling window.api
// directly: it makes the renderer's session I/O injectable. The remote
// mobile client (docs/superpowers/specs/2026-07-06-remote-mobile-companion-
// design.md) implements the same contract over WebSocket and mounts the
// same components; tests implement it with FakeSessionFeed and need no
// Electron. This object is the desktop's feed-selection point — the single
// place where "desktop = IPC" is decided.
//
// INVARIANT: every method must stay a zero-logic delegation. Any behaviour
// added here (filtering, buffering, retry) would silently diverge desktop
// from remote, because remote transports don't flow through this file. Put
// cross-transport behaviour in the consumers; put transport-specific
// behaviour in the transport (WebSocketSessionFeed does its own reconnect).
//
// WHY methods wrap `window.api` lazily instead of `export const
// ipcSessionFeed = window.api`: the preload bridge object is assembled by
// Electron's contextBridge at an unspecified moment relative to module
// evaluation, and tests stub `window` after module graphs load. Reading
// `window.api` at call time keeps this module import-safe in any order.
export const ipcSessionFeed: SessionFeed = {
  onSessionStarted: cb => window.api.onSessionStarted(cb),
  onSessionInputReadiness: cb => window.api.onSessionInputReadiness(cb),
  onSessionScreen: cb => window.api.onSessionScreen(cb),
  onSessionJsonlEntries: cb => window.api.onSessionJsonlEntries(cb),
  onSessionJsonlError: cb => window.api.onSessionJsonlError(cb),
  onSessionTranscriptDiagnostic: cb => window.api.onSessionTranscriptDiagnostic(cb),
  onSessionHistoryBoundary: cb => window.api.onSessionHistoryBoundary(cb),
  onSessionProviderSessionChanged: cb => window.api.onSessionProviderSessionChanged(cb),
  onSessionSemanticEvent: cb => window.api.onSessionSemanticEvent(cb),
  onSessionConditions: cb => window.api.onSessionConditions(cb),
  onSessionProcessState: cb => window.api.onSessionProcessState(cb),
  onSessionSubAgents: cb => window.api.onSessionSubAgents(cb),
  onSessionExit: cb => window.api.onSessionExit(cb),
  sendInput: (sessionId, data, pasteId) => window.api.sendInput(sessionId, data, pasteId),
  deliverPrompt: (sessionId, prompt, imagePaths, deliveryId) =>
    window.api.deliverPrompt(sessionId, prompt, imagePaths, deliveryId),
  resolveCondition: (sessionId, action) => window.api.resolveCondition(sessionId, action),
  // The one place this object does more than rename: the contract has one
  // history call and the preload bridge has two, keyed by whether a cursor
  // exists. Choosing between them is still delegation (no retry, no
  // buffering, no reshaping of the reply), and the arguments are exactly the
  // objects the history actions passed before #1177, so main sees the same
  // IPC it always did.
  loadHistory: async request => {
    // Desktop main cannot resolve history from a session id alone (see
    // SessionHistoryRequest.transcript), so a request without the durable
    // identity is a caller bug, reported as a rejection like any failed read.
    const transcript = request.transcript
    if (!transcript) throw new Error('Desktop history requires the durable transcript identity.')
    return request.beforeMarker === undefined
      ? window.api.loadInitialHistory({ ...transcript, limit: request.limit })
      : window.api.loadOlderHistory({
          ...transcript,
          beforeMarker: request.beforeMarker,
          beforeOffset: request.beforeOffset,
          limit: request.limit,
        })
  },
}
