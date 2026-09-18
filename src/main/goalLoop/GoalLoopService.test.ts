import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildGoalLoopContinuationPrompt } from '@mcp/shared/goalLoopPrompt.js'
import { GoalLoopService } from './GoalLoopService.js'
import { GoalLoopStore } from './GoalLoopStore.js'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(d => rm(d, { recursive: true, force: true }))) })

type FakeManager = EventEmitter & { deliverPromptToAgent: ReturnType<typeof vi.fn> }
async function service(deliver: FakeManager['deliverPromptToAgent'] = vi.fn(async () => ({ ok: true }))) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-code-goal-loop-'))
  directories.push(directory)
  const manager = Object.assign(new EventEmitter(), { deliverPromptToAgent: deliver }) as FakeManager
  const svc = new GoalLoopService({ manager, store: new GoalLoopStore(join(directory, 'goal-loop.json')), now: () => new Date('2026-09-18T00:00:00.000Z') })
  await svc.start()
  return { svc, manager, deliver }
}
const idleTurn = (manager: FakeManager) => manager.emit('semantic-event', { sessionId: 's1', event: { type: 'turn_completed' } })

describe('GoalLoopService', () => {
  it('delivers the continuation prompt when the session goes idle without completion', async () => {
    const { svc, manager, deliver } = await service()
    await svc.startLoop('s1', { goal: 'Migrate tests.', loopPrompt: 'Keep migrating.' })
    idleTurn(manager)
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1))
    expect(deliver).toHaveBeenCalledWith('s1', buildGoalLoopContinuationPrompt({
      goal: 'Migrate tests.', loopPrompt: 'Keep migrating.', iteration: 1, maxContinuations: 25,
    }))
    expect(svc.snapshot()['s1']?.continuationsDelivered).toBe(1)
  })
  it('does not continue while tools are pending (awaiting-tool)', async () => {
    const { svc, manager, deliver } = await service()
    await svc.startLoop('s1', { goal: 'G.', loopPrompt: 'P.' })
    manager.emit('semantic-event', { sessionId: 's1', event: { type: 'stream_phase', phase: 'awaiting-tool', toolUseId: 't1' } })
    idleTurn(manager)
    expect(deliver).not.toHaveBeenCalled()
  })
  it('ends on complete and never delivers again', async () => {
    const { svc, manager, deliver } = await service()
    await svc.startLoop('s1', { goal: 'G.', loopPrompt: 'P.' })
    await svc.complete('s1', 'done', 'All requirements verified.')
    idleTurn(manager)
    expect(deliver).not.toHaveBeenCalled()
    expect(svc.snapshot()['s1']).toMatchObject({ phase: 'ended', endReason: 'done' })
  })
  it('pauses at the cap instead of hard-killing, and resume+raise continues', async () => {
    const { svc, manager, deliver } = await service()
    await svc.startLoop('s1', { goal: 'G.', loopPrompt: 'P.', maxContinuations: 1 })
    idleTurn(manager)
    // Wait on the committed continuation count, not the mock call: the call
    // fires before the service's synchronous post-delivery bookkeeping (the
    // working-state seed), which the next idleTurn depends on.
    await vi.waitFor(() => expect(svc.snapshot()['s1']?.continuationsDelivered).toBe(1))
    idleTurn(manager)
    await vi.waitFor(() => expect(svc.snapshot()['s1']?.phase).toBe('paused'))
    expect(svc.snapshot()['s1']?.pauseReason).toBe('cap')
    expect(deliver).toHaveBeenCalledTimes(1)
    svc.control('s1', { action: 'raise-cap', value: 2 })
    svc.control('s1', { action: 'resume' })
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2))
  })
  it('pauses after repeated delivery failures', async () => {
    const deliver = vi.fn(async () => ({ ok: false, retrySafe: true }))
    const { svc, manager } = await service(deliver)
    await svc.startLoop('s1', { goal: 'G.', loopPrompt: 'P.' })
    idleTurn(manager); await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2))
    idleTurn(manager); await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(4))
    idleTurn(manager)
    await vi.waitFor(() => expect(svc.snapshot()['s1']).toMatchObject({ phase: 'paused', pauseReason: 'error' }))
  })
  it('marks an active loop interrupted when the session is removed', async () => {
    const { svc, manager } = await service()
    await svc.startLoop('s1', { goal: 'G.', loopPrompt: 'P.' })
    manager.emit('removed', { sessionId: 's1' })
    expect(svc.snapshot()['s1']).toMatchObject({ phase: 'paused', pauseReason: 'interrupted' })
  })
  it('recovers persisted active loops as interrupted on start', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-code-goal-loop-'))
    directories.push(directory)
    await new GoalLoopStore(join(directory, 'goal-loop.json')).write({ s1: {
      sessionId: 's1', goal: 'G.', loopPrompt: 'P.', phase: 'active', pauseReason: null, endReason: null,
      completionSummary: null, maxContinuations: 25, continuationsDelivered: 2,
      consecutiveDeliveryFailures: 0, startedAt: '2026-09-18T00:00:00.000Z', updatedAt: '2026-09-18T00:00:00.000Z',
    } })
    const manager = Object.assign(new EventEmitter(), { deliverPromptToAgent: vi.fn() })
    const svc = new GoalLoopService({ manager, store: new GoalLoopStore(join(directory, 'goal-loop.json')) })
    await svc.start()
    expect(svc.snapshot()['s1']).toMatchObject({ phase: 'paused', pauseReason: 'interrupted' })
  })
  it('rejects a second concurrent loop and a complete with no loop', async () => {
    const { svc } = await service()
    await svc.startLoop('s1', { goal: 'G.', loopPrompt: 'P.' })
    await expect(svc.startLoop('s1', { goal: 'G2.', loopPrompt: 'P.' })).rejects.toThrow('already')
    await expect(svc.complete('other', 'done', 'x.')).rejects.toThrow('No goal loop')
  })
})
