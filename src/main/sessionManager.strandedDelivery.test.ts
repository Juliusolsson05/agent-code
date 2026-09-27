import { afterEach, expect, it, vi } from 'vitest'

import { SessionManager } from './sessionManager.js'
// Static, not imported inside the test (#1358 review b): a dynamic import of
// the control stack took over 5 s on a loaded machine and timed the test out.
import { terminalBackendCapabilities } from '@main/sessions/terminalControl.js'

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

// Steering q75 / #1358 review a (blocker) and c: the mark belongs to the
// PROCESS whose composer holds the bytes. Sequence: a delivery writes to
// process A; A exits and B takes the same session id; a human drafts in B;
// A's delivery then fails. The late failure must neither mark B nor let the
// next delivery clear B's composer.
it('never lets a late failure of a replaced process clear the new process\'s human draft', async () => {
  vi.useFakeTimers()
  const { manager } = claudeLike()
  const sessions = (manager as unknown as { sessions: Map<string, unknown> }).sessions
  const first = manager.deliverPromptToAgent('s1', 'an earlier prompt that painted late')
  await vi.advanceTimersByTimeAsync(100)
  // A exits (the manager's own cleanup) and B, same id, holds a human draft.
  ;(manager as unknown as { cleanupSessionState(id: string, kind: string): void }).cleanupSessionState('s1', 'claude')
  const bWrites: string[] = []
  const humanDraft = { screen: composer('❯ a human typed this'), attributes: { dim: 0, inverse: 1, plain: 18 } }
  sessions.set('s1', { kind: 'claude', session: {
    isExited: () => false,
    write: (data: string) => { bWrites.push(data) },
    snapshotScreen: () => humanDraft.screen,
    readComposer: () => humanDraft,
    awaitReadyForPrompt: async () => ({ kind: 'occupied' as const, reason: 'human-draft' as const, waitedMs: 0 }),
    armPromptAcceptance: () => ({ promise: new Promise(() => {}), cancel: vi.fn() }),
  } })
  await vi.advanceTimersByTimeAsync(8_000)
  await first
  vi.useRealTimers()
  expect(manager.hasStrandedDelivery('s1')).toBe(false)
  // The write side: A's late result must not even be stored. The read side
  // would ignore it, but a stored mark keeps A's dead RegistryEntry (and its
  // PTY wrapper) reachable until someone writes to B.
  expect((manager as unknown as { strandedDeliveries: Map<string, unknown> }).strandedDeliveries.has('s1')).toBe(false)

  const next = await manager.deliverPromptToAgent('s1', 'the next task')
  expect(next).toMatchObject({ ok: false, code: 'not-ready', promptWritten: false })
  expect(bWrites).toEqual([])
})

// The read side of the binding. Stable ids are reused after a failed provider
// start, and the replacement can be registered BEFORE the old wrapper's exit
// fires; that late exit's cleanup is generation-owned and deliberately leaves
// the new row (and so the old mark) alone. The mark still names A's entry, so
// neither inspection nor B's next delivery may treat it as B's. Without the
// entry comparison at the strandedComposer handoff, B's human draft gets Ctrl+U.
it('never hands a mark to a replacement registered before the old process was cleaned up', async () => {
  const { manager } = claudeLike()
  await strand(manager)
  expect(manager.hasStrandedDelivery('s1')).toBe(true)
  const bWrites: string[] = []
  const humanDraft = { screen: composer('❯ a human typed this'), attributes: { dim: 0, inverse: 1, plain: 18 } }
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set('s1', { kind: 'claude', session: {
    isExited: () => false,
    write: (data: string) => { bWrites.push(data) },
    snapshotScreen: () => humanDraft.screen,
    readComposer: () => humanDraft,
    awaitReadyForPrompt: async () => ({ kind: 'occupied' as const, reason: 'human-draft' as const, waitedMs: 0 }),
    armPromptAcceptance: () => ({ promise: new Promise(() => {}), cancel: vi.fn() }),
  } })
  expect(manager.hasStrandedDelivery('s1')).toBe(false)
  const next = await manager.deliverPromptToAgent('s1', 'the next task')
  expect(next).toMatchObject({ ok: false, code: 'not-ready', promptWritten: false })
  expect(bWrites).toEqual([])
})

// #1358 review c: the recorded paint lag is 0.7-3.8 s after the failure. A
// delivery that starts inside it sees an empty, ready composer; writing then
// would put its prompt after (or before) our late-painting bytes, and one
// Enter could submit both. While the mark stands it waits for the late paint
// (bounded), then reclaims.
it('waits for the stranded text to paint before writing, then clears it', async () => {
  const { manager, session, writes } = claudeLike()
  await strand(manager)
  vi.useFakeTimers()
  const next = manager.deliverPromptToAgent('s1', 'the next task')
  await vi.advanceTimersByTimeAsync(2_000)
  session.paintLate()
  await vi.advanceTimersByTimeAsync(10_000)
  await expect(next).resolves.toMatchObject({ ok: true })
  expect(writes.slice(1)).toEqual(['\x15', 'the next task', '\r'])
})

// #1358 reviews a and c: whether Ctrl+U removes an image pill is not
// established, so an image delivery's leftovers are never reclaimed.
it('does not mark an image delivery that stranded', async () => {
  const { manager } = claudeLike()
  vi.useFakeTimers()
  const first = manager.deliverPromptToAgent('s1', '', ['/tmp/screenshot.png'])
  await vi.advanceTimersByTimeAsync(30_000)
  expect(await first).toMatchObject({ ok: false, promptWritten: true, enterWritten: false })
  vi.useRealTimers()
  expect(manager.hasStrandedDelivery('s1')).toBe(false)
})

// #1358 verification a (blocker): a delivery that WROTE supersedes whatever
// mark stood. Sequence: text strands and paints; an image delivery reclaims it
// (Ctrl+U), writes its image, and strands too. The old text mark must not
// survive that, or the third delivery Ctrl+Us a composer holding image pills.
it('retires the text mark once an image delivery has written over it', async () => {
  const { manager, session, writes } = claudeLike()
  await strand(manager)
  session.paintLate()
  vi.useFakeTimers()
  const image = manager.deliverPromptToAgent('s1', '', ['/tmp/screenshot.png'])
  await vi.advanceTimersByTimeAsync(30_000)
  expect(await image).toMatchObject({ ok: false, promptWritten: true, enterWritten: false })
  vi.useRealTimers()
  expect(writes.filter(data => data === '\x15')).toHaveLength(1)
  expect(manager.hasStrandedDelivery('s1')).toBe(false)

  // The image's leftovers paint; the next delivery must refuse, not reclaim.
  session.paintLate()
  const next = await manager.deliverPromptToAgent('s1', 'the next task')
  expect(next).toMatchObject({ ok: false, code: 'not-ready', promptWritten: false })
  expect(writes.filter(data => data === '\x15')).toHaveLength(1)
})

// #1358 review a (surviving mutant): a write that throws after bytes may have
// crossed is stranded too; review c (surviving mutant): process exit clears it.
it('marks a delivery whose write threw, and forgets it when the process exits', async () => {
  const { manager, session } = claudeLike()
  const write = session.write
  session.write = (data: string) => { if (data === 'an earlier prompt that painted late') throw new Error('EPIPE'); write(data) }
  const result = await manager.deliverPromptToAgent('s1', 'an earlier prompt that painted late')
  expect(result).toMatchObject({ ok: false, code: 'transport-failed', promptWritten: true })
  expect(manager.hasStrandedDelivery('s1')).toBe(true)
  ;(manager as unknown as { cleanupSessionState(id: string, kind: string): void }).cleanupSessionState('s1', 'claude')
  expect(manager.hasStrandedDelivery('s1')).toBe(false)
  // Checked on the map itself: once the row is gone the read-side entry check
  // already hides the mark, so only this shows the exit clear still runs (a
  // kept mark would pin the dead process's RegistryEntry).
  expect((manager as unknown as { strandedDeliveries: Map<string, unknown> }).strandedDeliveries.has('s1')).toBe(false)
})

// #1358 review b (surviving mutant): a delivery refused before writing leaves
// the composer as it was, so it must not create a mark.
it('does not mark a delivery that was refused before writing', async () => {
  const { manager, session, writes } = claudeLike()
  session.paintLate()
  const result = await manager.deliverPromptToAgent('s1', 'the next task')
  expect(result).toMatchObject({ ok: false, code: 'not-ready', promptWritten: false })
  expect(writes).toEqual([])
  expect(manager.hasStrandedDelivery('s1')).toBe(false)
})

// #1358 review b: only Claude's delivery can reclaim a stranded composer, so
// only a Claude session is marked; inspection must not promise a reclaim no
// delivery will perform.
//
// WHY Pi and not Codex: the guard is only reachable by a non-Claude failure
// that reports promptWritten && !enterWritten. Codex writes paste + Enter in
// ONE atomic PTY write (codex/runtime/promptDelivery.ts), so any Codex failure
// after writing is already enterWritten and never reaches the kind check (a
// Codex version of this test passed with the guard deleted). Pi's bridge
// answers "unknown" when the request reached pi with no evidence back, which
// pi/runtime/promptDelivery.ts reports as exactly that pair.
it('does not mark a stranded delivery for a provider that cannot reclaim it', async () => {
  const { manager } = claudeLike()
  const unknownOutcome = Object.assign(new Error('bridge went quiet'), { code: 'pi-terminal-unknown' })
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set('s1', { kind: 'pi', session: {
    isExited: () => false,
    write: () => {},
    deliverPromptText: async () => { throw unknownOutcome },
  } })
  const result = await manager.deliverPromptToAgent('s1', 'an earlier prompt that painted late')
  expect(result).toMatchObject({ ok: false, promptWritten: true, enterWritten: false })
  expect(manager.hasStrandedDelivery('s1')).toBe(false)
})
