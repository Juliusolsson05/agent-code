import { describe, expect, it, vi } from 'vitest'

import { SessionManager } from './sessionManager.js'
import type { PromptAcceptanceOutcome } from '@shared/types/session.js'

describe('SessionManager prompt delivery reservation', () => {
  it('rejects an overlapping delivery before the second prompt writes bytes', async () => {
    let resolveAcceptance!: (value: PromptAcceptanceOutcome) => void
    const acceptance = new Promise<PromptAcceptanceOutcome>(resolve => {
      resolveAcceptance = resolve
    })
    let screen = '❯'
    const write = vi.fn((data: string) => {
      if (data !== '\r') screen = `❯ ${data}`
    })
    const session = {
      write,
      isExited: () => false,
      snapshotScreen: () => screen,
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
    // WHY two writes are expected: Claude's current protocol proves that the
    // prompt reached the active composer before sending Enter. This manager
    // test must model that protocol because its reservation spans both writes.
    expect(write.mock.calls.map(([data]) => data)).toEqual(['first', '\r'])

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
    let screen = '❯'
    const session = {
      write: vi.fn((data: string) => {
        if (data !== '\r') screen = `❯ ${data}`
      }),
      isExited: () => false,
      snapshotScreen: () => screen,
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

  it('treats a throwing PTY prompt write as potentially written and blocks condition interleaving', async () => {
    let release!: (value: PromptAcceptanceOutcome) => void
    const acceptance = new Promise<PromptAcceptanceOutcome>(resolve => { release = resolve })
    const resolveCondition = vi.fn(async () => ({ ok: true as const }))
    const session = {
      write: vi.fn(() => { throw new Error('pty boundary failed') }),
      isExited: () => false,
      snapshotScreen: () => '❯',
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
      // WHY false is still the conservative answer: the prompt write may have
      // crossed node-pty, but the separate Enter boundary was never attempted.
      enterWritten: false,
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

  it('blocks every external write while a delivery holds the reservation', async () => {
    // The guard is unconditional on purpose. An earlier cut of the Codex
    // trust-dialog fix punched a hole here for "any active condition"; it was
    // inert in production (it probed a method no session implements) and would
    // have admitted raw terminal typing, dictation and paste mid-delivery had
    // it worked. The deadlock is fixed by providers reporting 'blocked' so
    // delivery aborts instead of retrying — not by widening this.
    const session = {
      write: () => true,
      isExited: () => false,
      snapshotScreen: () => ({ plain: '', markdown: '', recent: '', recentMarkdown: '' }),
      awaitReadyForPrompt: async () => ({
        kind: 'blocked' as const, condition: 'codex.trust-dialog', resolvable: true,
      }),
    }
    const manager = new SessionManager()
    ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set('s1', {
      kind: 'codex', session,
    })

    const delivery = manager.deliverPromptToAgent('s1', 'queued prompt')
    expect(manager.write('s1', '\r')).toBe(false)

    // The causal link the whole fix rests on: a blocked gate must surface as
    // 'retry-after-resolve' (a human must act), NOT 'retry-same-session' (try
    // again now). Nothing else asserted this, so the chain was unverified.
    await expect(delivery).resolves.toMatchObject({
      ok: false,
      code: 'not-ready',
      disposition: 'retry-after-resolve',
    })

    // And the reservation releases immediately afterwards, so the modal's
    // keystrokes get through rather than waiting out a 15s poll.
    expect(manager.write('s1', '\r')).toBe(true)
  })
})
