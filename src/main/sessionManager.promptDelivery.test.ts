import { describe, expect, it, vi } from 'vitest'

import { SessionManager } from './sessionManager.js'
import type { PromptAcceptanceOutcome } from '@shared/types/session.js'

describe('SessionManager prompt delivery reservation', () => {
  it('rejects an overlapping delivery before the second prompt writes bytes', async () => {
    let resolveAcceptance!: (value: PromptAcceptanceOutcome) => void
    const acceptance = new Promise<PromptAcceptanceOutcome>(resolve => {
      resolveAcceptance = resolve
    })
    const write = vi.fn()
    const session = {
      write,
      isExited: () => false,
      armPromptAcceptance: () => ({ promise: acceptance, cancel: vi.fn() }),
    }
    const manager = new SessionManager()
    // WHY install a structural session directly: this test exercises the
    // manager's critical section, not process spawning. A real Claude PTY would
    // make the overlap timing nondeterministic and obscure the invariant that
    // only one provider protocol may own a session at a time.
    ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set('s1', {
      kind: 'claude',
      session,
    })

    const first = manager.deliverPromptToAgent('s1', 'first')
    const second = await manager.deliverPromptToAgent('s1', 'second')

    expect(second).toMatchObject({
      ok: false,
      code: 'delivery-in-flight',
      retrySafe: true,
      promptWritten: false,
    })
    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith('first\r')

    resolveAcceptance({ kind: 'user', acceptedAt: 123 })
    await expect(first).resolves.toMatchObject({ ok: true })
  })
})
