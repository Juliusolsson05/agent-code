import { afterEach, describe, expect, it } from 'vitest'

import {
  __resetCloseConfirmationForTests,
  currentCloseConfirmation,
  requestCloseConfirmation,
  resolveCloseConfirmation,
  subscribeToCloseConfirmation,
} from '@renderer/workspace/closeConfirmationBroker'

const request = {
  required: true as const,
  reason: 'multi' as const,
  targets: [
    { sessionId: 'a', title: 'A', live: false },
    { sessionId: 'b', title: 'B', live: true },
  ],
  summary: 'This closes 2 sessions, 1 still working.',
}

afterEach(() => {
  // Module state must not leak between tests, or an unresolved promise from one
  // silently changes the next.
  __resetCloseConfirmationForTests()
})

describe('close confirmation broker', () => {
  it('resolves true when the user confirms', async () => {
    const answer = requestCloseConfirmation(request)
    resolveCloseConfirmation(true)
    await expect(answer).resolves.toBe(true)
  })

  it('resolves false when the user cancels', async () => {
    const answer = requestCloseConfirmation(request)
    resolveCloseConfirmation(false)
    await expect(answer).resolves.toBe(false)
  })

  it('exposes the pending request for rendering and clears it on answer', () => {
    void requestCloseConfirmation(request)
    expect(currentCloseConfirmation()?.request.summary).toContain('2 sessions')
    resolveCloseConfirmation(false)
    expect(currentCloseConfirmation()).toBeNull()
  })

  it('notifies subscribers on open and close', () => {
    const seen: (string | null)[] = []
    const unsubscribe = subscribeToCloseConfirmation(pending =>
      seen.push(pending?.request.summary ?? null),
    )
    void requestCloseConfirmation(request)
    resolveCloseConfirmation(false)
    unsubscribe()
    // Initial null, the request, then null again.
    expect(seen).toHaveLength(3)
    expect(seen[0]).toBeNull()
    expect(seen[1]).toContain('2 sessions')
    expect(seen[2]).toBeNull()
  })

  it('declines a superseded request rather than abandoning its promise', async () => {
    // An abandoned promise leaves its close path awaiting forever, which
    // presents as a pane that will not close and no error anywhere — worse
    // than a refusal the user can simply retry.
    const first = requestCloseConfirmation(request)
    const second = requestCloseConfirmation(request)
    await expect(first).resolves.toBe(false)
    resolveCloseConfirmation(true)
    await expect(second).resolves.toBe(true)
  })

  it('is safe to answer with nothing pending', () => {
    expect(() => resolveCloseConfirmation(true)).not.toThrow()
  })

  it('stops notifying after unsubscribe', () => {
    let calls = 0
    const unsubscribe = subscribeToCloseConfirmation(() => { calls += 1 })
    const afterInitial = calls
    unsubscribe()
    void requestCloseConfirmation(request)
    expect(calls).toBe(afterInitial)
  })
})
