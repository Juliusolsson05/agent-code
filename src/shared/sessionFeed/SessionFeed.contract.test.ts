import { describe, expect, it } from 'vitest'

import type { SessionFeed } from '@shared/sessionFeed/SessionFeed.js'

// A no-op feed proves the interface is implementable with the exact member
// names the desktop (IpcSessionFeed) and phone (WebSocketSessionFeed)
// implementations rely on. This is a compile-time contract lock: if a member
// name or signature drifts, this file fails to type-check before any runtime
// test runs. The runtime assertions below are deliberately thin — the value
// of this test is the `const noop: SessionFeed = { ... }` line.
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

describe('SessionFeed contract', () => {
  it('is implementable and exposes the v1 command surface', () => {
    expect(typeof noop.sendInput).toBe('function')
    expect(typeof noop.deliverPrompt).toBe('function')
    expect(typeof noop.resolveCondition).toBe('function')
  })

  it('listeners return an unsubscribe function', () => {
    const unsub = noop.onSessionScreen(() => {})
    expect(typeof unsub).toBe('function')
  })
})
