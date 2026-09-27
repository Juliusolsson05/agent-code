import { afterEach, expect, it, vi } from 'vitest'

import { SessionManager } from './sessionManager.js'

// #1350, end to end through the manager and the real Claude delivery code.
// Recorded shape (lifecycle journal, three incidents on 2026-09-27): a
// delivery writes its prompt while Claude is busy, the text does not paint
// within absorption (5 s) plus the rollback's observe window, the delivery
// gives up "could not be recovered", and the text paints 0.7-3.8 s later.
// Claude's gate then reads it as a human draft for good.
afterEach(() => { vi.useRealTimers() })

const RULE = '─'.repeat(40)
const composer = (row: string) => [RULE, row, RULE].join('\n')

function claudeLike() {
  const writes: string[] = []
  // 'busy': our text is in Claude's buffer but not painted (the incident);
  // 'stranded': it painted late; 'empty'; 'prompted': the next prompt shows.
  let state: 'idle' | 'busy' | 'stranded' | 'empty' | 'prompted' = 'idle'
  const frame = () => state === 'stranded'
    ? { screen: composer('❯ an earlier prompt that painted late'), attributes: { dim: 0, inverse: 1, plain: 33 } }
    : state === 'prompted'
      ? { screen: composer('❯ the next task'), attributes: { dim: 0, inverse: 1, plain: 13 } }
      : { screen: composer('❯'), attributes: null }
  const session = {
    isExited: () => false,
    write: (data: string) => {
      writes.push(data)
      if (data === 'an earlier prompt that painted late') state = 'busy'
      else if (data === '\x15' && state === 'stranded') state = 'empty'
      else if (data === 'the next task') state = 'prompted'
      else if (data === '\r') state = 'idle'
      else if (state === 'stranded' || state === 'idle') state = 'stranded'
    },
    snapshotScreen: () => frame().screen,
    readComposer: () => frame(),
    awaitReadyForPrompt: async () => state === 'stranded'
      ? { kind: 'occupied' as const, reason: 'human-draft' as const, waitedMs: 0 }
      : { kind: 'ready' as const, waitedMs: 0 },
    armPromptAcceptance: () => ({ promise: Promise.resolve({ kind: 'user' as const, acceptedAt: 1 }), cancel: vi.fn() }),
    paintLate: () => { state = 'stranded' },
  }
  const manager = new SessionManager()
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set('s1', { kind: 'claude', session })
  return { manager, session, writes }
}

async function strand(manager: SessionManager) {
  vi.useFakeTimers()
  const first = manager.deliverPromptToAgent('s1', 'an earlier prompt that painted late')
  await vi.advanceTimersByTimeAsync(8_000)
  const result = await first
  vi.useRealTimers()
  return result
}

it('reclaims its own stranded prompt on the next delivery', async () => {
  const { manager, session, writes } = claudeLike()
  expect(await strand(manager)).toMatchObject({ ok: false, code: 'absorption-timeout', promptWritten: true, enterWritten: false })
  expect(manager.hasStrandedDelivery('s1')).toBe(true)
  session.paintLate()

  await expect(manager.deliverPromptToAgent('s1', 'the next task')).resolves.toMatchObject({ ok: true })
  expect(writes.slice(1)).toEqual(['\x15', 'the next task', '\r'])
  expect(manager.hasStrandedDelivery('s1')).toBe(false)
})

it('treats the composer as a human draft again once anyone else has written to it', async () => {
  const { manager, session, writes } = claudeLike()
  await strand(manager)
  session.paintLate()
  // Raw terminal typing reaches the same composer; the text is no longer
  // provably ours alone.
  expect(manager.write('s1', 'x')).toBe(true)
  expect(manager.hasStrandedDelivery('s1')).toBe(false)

  const result = await manager.deliverPromptToAgent('s1', 'the next task')
  expect(result).toMatchObject({ ok: false, code: 'not-ready', promptWritten: false })
  expect(result.ok ? '' : result.message).toContain('occupied by a human draft')
  expect(writes).not.toContain('\x15')
})

it('reports our own stranded write to input inspection', async () => {
  const { terminalBackendCapabilities } = await import('@main/sessions/terminalControl.js')
  const { manager } = claudeLike()
  await strand(manager)
  vi.spyOn(manager, 'getBackendSnapshot').mockReturnValue({
    sessionId: 's1', sessionRunId: 'run-1', kind: 'claude', cwd: '/repo', lifecycle: 'live',
    input: { ready: false, reason: 'composer-occupied', revision: 2 },
  } as never)
  const context = { requestId: 'inspect', caller: { kind: 'application' as const, id: 'renderer' }, owner: { kind: 'main' as const, generation: 'one' } }
  const inspect = terminalBackendCapabilities(manager).find(item => item.descriptor.id === 'sessions.inputInspect')!
  const result = await inspect.execute({ sessionId: 's1', cwd: '/repo', provider: 'claude' }, context)
  if (!result.ok) throw new Error(JSON.stringify(result))
  const { nativeDraft } = result.value as { nativeDraft: { state: string; strandedDelivery: boolean; reason: string } }
  expect(nativeDraft).toMatchObject({ state: 'occupied', strandedDelivery: true })
  expect(nativeDraft.reason).toContain('earlier Agent Code prompt')
})
