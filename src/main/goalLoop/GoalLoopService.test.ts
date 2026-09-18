import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionManager } from '@main/sessionManager.js'
import type { PromptDeliveryResult } from '@shared/types/providerConfig.js'
import { buildGoalLoopContinuationPrompt } from '@mcp/shared/goalLoopPrompt.js'
import { GoalLoopService } from './GoalLoopService.js'
import { GOAL_LOOP_STORE_LIMIT, GoalLoopStore } from './GoalLoopStore.js'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(d => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))) })

type Deliver = SessionManager['deliverPromptToAgent']
type FakeManager = EventEmitter & { deliverPromptToAgent: Deliver }
async function service(deliver: Deliver = vi.fn(async () => ({ ok: true } as PromptDeliveryResult))) {
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
    const deliver = vi.fn(async () => ({ ok: false, retrySafe: true } as PromptDeliveryResult))
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
  // ── Review of #1003. Every case below failed against the first version,
  // except the one marked as a preservation guard: it passed before and pins
  // the behaviour the state-tracking rewrite was not allowed to change. ──
  const emit = (manager: FakeManager, event: Record<string, unknown>) => manager.emit('semantic-event', { sessionId: 's1', event })
  const settle = () => new Promise(resolve => setTimeout(resolve, 20))

  it('never re-sends a delivery that may already have reached the agent', async () => {
    // retrySafe:false = prompt bytes or Enter already hit the PTY. The backoff
    // retry used to ignore that and deliver the same continuation again.
    const deliver = vi.fn(async () => ({
      ok: false, retrySafe: false, stage: 'after-enter', code: 'acceptance-timeout', message: 'timed out',
      disposition: 'do-not-retry', promptWritten: true, enterWritten: true,
    } as PromptDeliveryResult))
    const { svc, manager } = await service(deliver)
    await svc.startLoop('s1', { goal: 'G.', loopPrompt: 'P.' })
    idleTurn(manager)
    await vi.waitFor(() => expect(svc.snapshot()['s1']).toMatchObject({ phase: 'paused', pauseReason: 'error' }))
    // Longer than DELIVERY_RETRY_DELAY_MS: a scheduled backoff would land here.
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(deliver).toHaveBeenCalledTimes(1)
  })
  it('holds continuation #1 while the goal_loop_start tool call itself is unresolved', async () => {
    // Claude's real ordering: the tool_use block starts streaming long before
    // the MCP call, but that message's turn_completed reaches main AFTER it
    // (200 ms proxy poll). The loop must not read that as the agent going idle.
    const { svc, manager, deliver } = await service()
    emit(manager, { type: 'stream_phase', phase: 'responding' })
    emit(manager, { type: 'block_started', kind: 'tool_use', toolUseId: 'start-call' })
    await svc.startLoop('s1', { goal: 'G.', loopPrompt: 'P.' })
    emit(manager, { type: 'turn_completed' })
    emit(manager, { type: 'stream_phase', phase: 'awaiting-tool', toolUseId: 'start-call' })
    await settle()
    expect(deliver).not.toHaveBeenCalled()
    emit(manager, { type: 'tool_result', toolUseId: 'start-call' })
    emit(manager, { type: 'turn_completed' })
    emit(manager, { type: 'stream_phase', phase: 'idle' })
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1))
  })
  it('resumes a loop that was paused mid-turn once that turn has ended', async () => {
    // The turn end arrives while paused. It used to be dropped, leaving the
    // state "responding" forever, so Resume activated the loop and then waited
    // on a turn that had already finished.
    const { svc, manager, deliver } = await service()
    await svc.startLoop('s1', { goal: 'G.', loopPrompt: 'P.' })
    svc.control('s1', { action: 'pause' })
    idleTurn(manager)
    await settle()
    expect(deliver).not.toHaveBeenCalled()
    svc.control('s1', { action: 'resume' })
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1))
  })
  it('leaves a working agent alone on resume and continues when its turn ends', async () => {
    // Preservation guard (passed before the review too): tracking state while
    // paused must not turn Resume into "prompt no matter what".
    const { svc, manager, deliver } = await service()
    await svc.startLoop('s1', { goal: 'G.', loopPrompt: 'P.' })
    svc.control('s1', { action: 'pause' })
    svc.control('s1', { action: 'resume' })
    await settle()
    expect(deliver).not.toHaveBeenCalled()
    idleTurn(manager)
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1))
  })
  it('does not deliver twice when pause then resume race an in-flight delivery', async () => {
    let release: (result: PromptDeliveryResult) => void = () => {}
    const deliver = vi.fn(() => new Promise<PromptDeliveryResult>(resolve => { release = resolve }))
    const { svc, manager } = await service(deliver)
    await svc.startLoop('s1', { goal: 'G.', loopPrompt: 'P.' })
    idleTurn(manager)
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1))
    svc.control('s1', { action: 'pause' })
    svc.control('s1', { action: 'resume' })
    release({ ok: true, acceptance: { kind: 'user', acceptedAt: 0 } })
    await vi.waitFor(() => expect(svc.snapshot()['s1']?.continuationsDelivered).toBe(1))
    await settle()
    expect(deliver).toHaveBeenCalledTimes(1)
  })
  it('gives a resumed loop a fresh failure budget', async () => {
    const deliver = vi.fn(async () => ({ ok: false, retrySafe: true } as PromptDeliveryResult))
    const { svc, manager } = await service(deliver)
    await svc.startLoop('s1', { goal: 'G.', loopPrompt: 'P.' })
    idleTurn(manager)
    await vi.waitFor(() => expect(svc.snapshot()['s1']).toMatchObject({ phase: 'paused', pauseReason: 'error' }))
    svc.control('s1', { action: 'resume' })
    expect(svc.snapshot()['s1']?.consecutiveDeliveryFailures).toBe(0)
  })
  it('dismisses an ended loop but never a live one', async () => {
    const { svc } = await service()
    await svc.startLoop('s1', { goal: 'G.', loopPrompt: 'P.' })
    expect(svc.control('s1', { action: 'dismiss' })).toMatchObject({ phase: 'active' })
    expect(svc.snapshot()['s1']).toBeDefined()
    svc.control('s1', { action: 'stop' })
    expect(svc.control('s1', { action: 'dismiss' })).toBeNull()
    expect(svc.snapshot()['s1']).toBeUndefined()
  })
  it('evicts the oldest history when full, never an active loop or the newest entries', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-code-goal-loop-'))
    directories.push(directory)
    const stamp = (index: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString()
    const persisted = Object.fromEntries(Array.from({ length: GOAL_LOOP_STORE_LIMIT }, (_, index) => {
      const phase = index % 2 === 0 ? 'ended' as const : 'paused' as const
      return [`old-${index}`, {
        sessionId: `old-${index}`, goal: 'G.', loopPrompt: 'P.', phase,
        pauseReason: phase === 'paused' ? 'interrupted' as const : null, endReason: phase === 'ended' ? 'done' as const : null,
        completionSummary: null, maxContinuations: 25, continuationsDelivered: 0, consecutiveDeliveryFailures: 0,
        startedAt: stamp(index), updatedAt: stamp(index),
      }]
    }))
    const file = join(directory, 'goal-loop.json')
    await new GoalLoopStore(file).write(persisted)
    const manager = Object.assign(new EventEmitter(), { deliverPromptToAgent: vi.fn() })
    const svc = new GoalLoopService({ manager, store: new GoalLoopStore(file) })
    await svc.start()
    await svc.startLoop('fresh', { goal: 'G.', loopPrompt: 'P.' })
    const kept = svc.snapshot()
    expect(Object.keys(kept)).toHaveLength(GOAL_LOOP_STORE_LIMIT)
    // The first version's trailing slice dropped exactly this one.
    expect(kept['fresh']).toMatchObject({ phase: 'active' })
    // old-0 is the oldest ENDED loop: history goes before anything resumable.
    expect(kept['old-0']).toBeUndefined()
    expect(kept['old-1']).toMatchObject({ phase: 'paused' })
    // What was written must be readable on the next launch.
    expect(Object.keys(await new GoalLoopStore(file).read())).toHaveLength(GOAL_LOOP_STORE_LIMIT)
  })
  it('keeps unreadable storage on disk when it starts empty over it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-code-goal-loop-'))
    directories.push(directory)
    const file = join(directory, 'goal-loop.json')
    await writeFile(file, '{broken')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = new GoalLoopStore(file)
    const svc = new GoalLoopService({ manager: Object.assign(new EventEmitter(), { deliverPromptToAgent: vi.fn() }), store })
    await svc.start()
    warn.mockRestore()
    // start() persists immediately, which used to replace the bad file.
    expect(await readFile(store.quarantineFile, 'utf8')).toBe('{broken')
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 1, loops: {} })
  })
  it('rejects a second concurrent loop and a complete with no loop', async () => {
    const { svc } = await service()
    await svc.startLoop('s1', { goal: 'G.', loopPrompt: 'P.' })
    await expect(svc.startLoop('s1', { goal: 'G2.', loopPrompt: 'P.' })).rejects.toThrow('already')
    await expect(svc.complete('other', 'done', 'x.')).rejects.toThrow('No goal loop')
  })
})
