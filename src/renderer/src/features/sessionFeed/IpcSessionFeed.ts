import type { SessionFeed } from '@shared/sessionFeed/SessionFeed'

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
  onSessionSemanticEvent: cb => window.api.onSessionSemanticEvent(cb),
  onSessionConditions: cb => window.api.onSessionConditions(cb),
  onSessionProcessState: cb => window.api.onSessionProcessState(cb),
  onSessionSubAgents: cb => window.api.onSessionSubAgents(cb),
  onSessionExit: cb => window.api.onSessionExit(cb),
  sendInput: (sessionId, data, pasteId) => window.api.sendInput(sessionId, data, pasteId),
  deliverPrompt: (sessionId, prompt, imagePaths, deliveryId) =>
    window.api.deliverPrompt(sessionId, prompt, imagePaths, deliveryId),
  resolveCondition: (sessionId, action) => window.api.resolveCondition(sessionId, action),
}
