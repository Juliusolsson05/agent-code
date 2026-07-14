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
    expect(manager.write('s1', '.')).toBe(false)
    expect(manager.write('s1', '\x1b[200~other\x1b[201~\r')).toBe(false)
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

  it('never sends delayed Enter into a replacement session with the same id', async () => {
    const oldWrite = vi.fn()
    const oldSession = {
      write: oldWrite,
      isExited: () => false,
      snapshotScreen: vi.fn()
        .mockReturnValueOnce('❯')
        .mockReturnValue('❯ line one line two'),
      armPromptAcceptance: () => ({
        promise: Promise.resolve({ kind: 'user' as const, acceptedAt: 123 }),
        cancel: vi.fn(),
      }),
    }
    const replacementWrite = vi.fn()
    const replacement = { write: replacementWrite, isExited: () => false }
    const manager = new SessionManager()
    const sessions = (manager as unknown as { sessions: Map<string, unknown> }).sessions
    sessions.set('s1', { kind: 'claude', session: oldSession })

    const delivery = manager.deliverPromptToAgent('s1', 'line one\nline two')
    sessions.set('s1', { kind: 'claude', session: replacement })
    const result = await delivery

    expect(result).toMatchObject({ ok: false, code: 'write-failed' })
    expect(replacementWrite).not.toHaveBeenCalled()
  })

  it('releases the reservation when provider setup throws', async () => {
    let attempts = 0
    const session = {
      write: vi.fn(),
      isExited: () => false,
      armPromptAcceptance: () => {
        attempts += 1
        if (attempts === 1) throw new Error('probe failed')
        return {
          promise: Promise.resolve({ kind: 'user' as const, acceptedAt: 123 }),
          cancel: vi.fn(),
        }
      },
    }
    const manager = new SessionManager()
    ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set('s1', {
      kind: 'claude', session,
    })
    await expect(manager.deliverPromptToAgent('s1', 'first')).resolves.toMatchObject({
      ok: false, retrySafe: true, promptWritten: false, enterWritten: false,
    })
    await expect(manager.deliverPromptToAgent('s1', 'second')).resolves.toMatchObject({ ok: true })
  })

  it('treats a throwing PTY write as potentially written and blocks condition interleaving', async () => {
    let release!: (value: PromptAcceptanceOutcome) => void
    const acceptance = new Promise<PromptAcceptanceOutcome>(resolve => { release = resolve })
    const resolveCondition = vi.fn(async () => ({ ok: true as const }))
    const session = {
      write: vi.fn(() => { throw new Error('pty boundary failed') }),
      isExited: () => false,
      resolveCondition,
      armPromptAcceptance: () => ({ promise: acceptance, cancel: vi.fn() }),
    }
    const manager = new SessionManager()
    ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set('s1', {
      kind: 'claude', session,
    })

    const delivery = manager.deliverPromptToAgent('s1', 'possibly written')
    await expect(manager.resolveCondition('s1', {} as never)).resolves.toMatchObject({
      ok: false,
      reason: 'aborted',
    })
    expect(resolveCondition).not.toHaveBeenCalled()
    await expect(delivery).resolves.toMatchObject({
      ok: false,
      retrySafe: false,
      promptWritten: true,
      enterWritten: true,
    })
    release({ kind: 'cancelled' })
  })

  it('reports a thrown pre-Enter paste write at the absorption stage', async () => {
    const session = {
      write: vi.fn(() => { throw new Error('pty boundary failed') }),
      isExited: () => false,
      snapshotScreen: () => '❯',
      armPromptAcceptance: () => ({
        promise: Promise.resolve({ kind: 'cancelled' as const }),
        cancel: vi.fn(),
      }),
    }
    const manager = new SessionManager()
    ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set('s1', {
      kind: 'claude', session,
    })
    await expect(manager.deliverPromptToAgent('s1', 'line one\nline two')).resolves.toMatchObject({
      ok: false,
      stage: 'absorption',
      retrySafe: false,
      promptWritten: true,
      enterWritten: false,
    })
  })
})
