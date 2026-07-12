import type { SessionFeed } from '@shared/sessionFeed/SessionFeed.js'

// Compile-time contract lock — deliberately NOT a vitest file. This was
// SessionFeed.contract.test.ts until the 2026-07 test audit: its two runtime
// `it` blocks were tautologies (they asserted properties of the `noop` literal
// defined below, exercising no production code), while ALL of the real value
// was always this typed const. If a SessionFeed member name or signature
// drifts, this file fails `tsc -b` (it's inside tsconfig.web.json's
// `src/shared/sessionFeed/**` include) before anything runs — which is exactly
// the guarantee the old runtime test pretended to add.
//
// A no-op feed proves the interface is implementable with the exact member
// names the desktop (IpcSessionFeed) and phone (WebSocketSessionFeed)
// implementations rely on.
const noop: SessionFeed = {
  onSessionStarted: () => () => {},
  onSessionScreen: () => () => {},
  onSessionJsonlEntries: () => () => {},
  onSessionJsonlError: () => () => {},
  onSessionSemanticEvent: () => () => {},
  onSessionConditions: () => () => {},
  onSessionProcessState: () => () => {},
  onSessionSubAgents: () => () => {},
  onSessionExit: () => () => {},
  sendInput: async () => true,
  deliverPrompt: async () => ({ ok: true }),
  resolveCondition: async () => ({ ok: true }),
}

// Reference the const so it cannot be flagged as dead and quietly deleted —
// deleting it would silently drop the contract lock.
void noop
