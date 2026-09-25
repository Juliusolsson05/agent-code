import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionManager } from '@main/sessionManager.js'
import type { PromptDeliveryResult } from '@shared/types/providerConfig.js'
import { buildGoalLoopContinuationPrompt } from '@mcp/shared/goalLoopPrompt.js'
import {
  GOAL_LOOP_ACTIVITY_GRACE_MS, GOAL_LOOP_BACKGROUND_WORK_LIMIT_MS, GOAL_LOOP_HOLD_LIMIT_MS, GOAL_LOOP_HOLD_STALL_MS, GOAL_LOOP_QUIET_TURN_MS, GoalLoopService,
} from './GoalLoopService.js'
import { GOAL_LOOP_STORE_LIMIT, GoalLoopStore } from './GoalLoopStore.js'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(d => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))) })

type Deliver = SessionManager['deliverPromptToAgent']
type FakeManager = EventEmitter & { deliverPromptToAgent: Deliver; getProcessStateSnapshot: () => { active: boolean } }
async function service(deliver: Deliver = vi.fn(async () => ({ ok: true } as PromptDeliveryResult))) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-code-goal-loop-'))
  directories.push(directory)
  // The provider's activity level, mutable so a test can put the agent back
  // to work between events. Idle by default: these cases are about the turn
  // boundary, not about #1033's delivery hold.
  const processState = { active: false }
  const manager = Object.assign(new EventEmitter(), { deliverPromptToAgent: deliver, getProcessStateSnapshot: () => processState }) as FakeManager
  const svc = new GoalLoopService({ manager, store: new GoalLoopStore(join(directory, 'goal-loop.json')), now: () => new Date('2026-09-18T00:00:00.000Z') })
  await svc.start()
  return { svc, manager, deliver, processState, storePath: join(directory, 'goal-loop.json') }
}
const idleTurn = (manager: FakeManager) => manager.emit('semantic-event', { sessionId: 's1', event: { type: 'turn_completed' } })
// The sequence the session's feed log recorded 4–60 ms before EVERY sampled
// mid-turn delivery (#1024): a Task subagent's API flow is selected on its
// first chunk while the main agent runs a local tool, then demoted as
// `cc_is_subagent`. The phase values are the ones the Claude proxy adapter
// publishes on that path: `requesting` on first-chunk promotion, `idle` on
// subagent demotion.
const subagentFlowInToolGap = (manager: FakeManager) => {
  manager.emit('semantic-event', { sessionId: 's1', event: { type: 'flow_selected', flowId: 'f-sub' } })
  manager.emit('semantic-event', { sessionId: 's1', event: { type: 'stream_phase', phase: 'requesting' } })
  manager.emit('semantic-event', { sessionId: 's1', event: { type: 'stream_phase', phase: 'idle' } })
  manager.emit('semantic-event', { sessionId: 's1', event: { type: 'flow_ignored', flowId: 'f-sub', reason: 'subagent' } })
}

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
  it('holds the continuation while the provider is still working, then delivers on its quiet edge (#1033)', async () => {
    const { svc, manager, deliver, processState } = await service()
    await svc.startLoop('s1', { goal: 'G.', loopPrompt: 'P.' })
    // The turn boundary says the turn ended; the provider says otherwise
    // (another Stop hook blocked ours and the model kept going).
    processState.active = true
    idleTurn(manager)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(deliver).not.toHaveBeenCalled()
    expect(svc.snapshot()['s1']).toMatchObject({ phase: 'active' })

    // No new boundary event ever arrives for that turn. The held continuation
    // is released by the provider itself, once.
    processState.active = false
    manager.emit('process-state', { sessionId: 's1', active: false })
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1))
    manager.emit('process-state', { sessionId: 's1', active: false })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(deliver).toHaveBeenCalledTimes(1)
  })
  it('is not stopped by a latched activity detector — the screen is outvoted (#1033 round 2)', async () => {
    // The spinner detector reports a COMPLETED tool row that is still in the
    // bottom fifteen lines (`⏺ 2 agents finished (ctrl+o to expand)`) as
    // activity, forever, on a session that is doing nothing. Holding on that
    // signal without a deadline is how a loop dies quietly, so the screen may
    // only postpone a delivery.
    const { svc, manager, deliver, processState } = await service()
    vi.useFakeTimers()
    try {
      await svc.startLoop('s1', { goal: 'G.', loopPrompt: 'P.' })
      processState.active = true
      idleTurn(manager)
      await vi.advanceTimersByTimeAsync(GOAL_LOOP_ACTIVITY_GRACE_MS - 2_000)
      expect(deliver).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(3_000)
      expect(deliver).toHaveBeenCalledTimes(1)
    } finally { vi.useRealTimers() }
  })

  it('holds while the model keeps streaming after an allowed Stop, even with the spinner down (#1033 round 2)', async () => {
    // ANOTHER configured Stop hook blocked ours: we were told the turn ended
    // and it did not. Claude hides its spinner while it streams visible text,
    // so the screen says idle here — the phase is what knows better, and it is
    // trustworthy precisely because these events are NEWER than the Stop.
    const { svc, manager, deliver, processState } = await service()
    vi.useFakeTimers()
    try {
      await svc.startLoop('s1', { goal: 'G.', loopPrompt: 'P.' })
      svc.observeProviderHook('s1', 'post-tool-use')
      svc.observeProviderHook('s1', 'stop', { blocked: false })
      processState.active = false
      manager.emit('semantic-event', { sessionId: 's1', event: { type: 'stream_phase', phase: 'responding' } })
      await vi.advanceTimersByTimeAsync(GOAL_LOOP_ACTIVITY_GRACE_MS + 10_000)
      expect(deliver).not.toHaveBeenCalled()

      // The continued turn finishes for real.
      idleTurn(manager)
      await vi.advanceTimersByTimeAsync(2_000)
      expect(deliver).toHaveBeenCalledTimes(1)
    } finally { vi.useRealTimers() }
  })

  it('pauses visibly when a hold never resolves (#1033)', async () => {
    // A turn that ended without a Stop (Claude skips it on Esc and on API
    // errors) leaves the turn open here forever. Nothing will ever release the
    // hold, so the loop must say so instead of looking armed.
    const { svc, deliver } = await service()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.useFakeTimers()
    try {
      await svc.startLoop('s1', { goal: 'G.', loopPrompt: 'P.' })
      svc.observeProviderHook('s1', 'user-prompt-submit')
      svc.control('s1', { action: 'pause' })
      svc.control('s1', { action: 'resume' })
      await vi.advanceTimersByTimeAsync(GOAL_LOOP_HOLD_STALL_MS + 2_000)
      expect(deliver).not.toHaveBeenCalled()
      expect(svc.snapshot()['s1']).toMatchObject({ phase: 'paused', pauseReason: 'error' })
    } finally { vi.useRealTimers(); warn.mockRestore() }
  })

  it('a turn that reopens restarts the stall clock instead of pausing live work (#1033 round 2)', async () => {
    const { svc, deliver } = await service()
    vi.useFakeTimers()
    try {
      await svc.startLoop('s1', { goal: 'G.', loopPrompt: 'P.' })
      svc.observeProviderHook('s1', 'user-prompt-submit')
      svc.control('s1', { action: 'pause' })
      svc.control('s1', { action: 'resume' })
      await vi.advanceTimersByTimeAsync(GOAL_LOOP_HOLD_STALL_MS - 60_000)
      // Real work is happening — a tool just ran. Pausing a loop for being
      // patient with a long turn is exactly the wrong answer.
      svc.observeProviderHook('s1', 'post-tool-use')
      await vi.advanceTimersByTimeAsync(GOAL_LOOP_HOLD_STALL_MS - 60_000)
      expect(svc.snapshot()['s1']).toMatchObject({ phase: 'active' })
      svc.observeProviderHook('s1', 'stop', { blocked: false })
      await vi.advanceTimersByTimeAsync(2_000)
      expect(deliver).toHaveBeenCalledTimes(1)
    } finally { vi.useRealTimers() }
  })

  it('a second resume does not throw away the first one\'s hold (#1033 round 2)', async () => {
    // Double-clicking Resume before the strip repaints used to clear the hold
    // on the second click while only the first one re-requested, leaving an
    // active loop with nothing pending and no timer looking at it again.
    const { svc, manager, deliver, processState } = await service()
    vi.useFakeTimers()
    try {
      await svc.startLoop('s1', { goal: 'G.', loopPrompt: 'P.' })
      processState.active = true
      idleTurn(manager)
      await vi.advanceTimersByTimeAsync(2_000)
      expect(deliver).not.toHaveBeenCalled()
      svc.control('s1', { action: 'pause' })
      svc.control('s1', { action: 'resume' })
      svc.control('s1', { action: 'resume' })
      processState.active = false
      await vi.advanceTimersByTimeAsync(2_000)
      expect(deliver).toHaveBeenCalledTimes(1)
    } finally { vi.useRealTimers() }
  })

  it('does not deliver again while a continuation sits in the provider QUEUE (#1033 round 3)', async () => {
    // A delivery that lands mid-turn is queued rather than started. The turn
    // that IS running belongs to someone else, so its Stop closes our
    // turn-open guard while our continuation has not begun — and the loop
    // sent a second one. Measured: two deliveries where the design promises
    // at most one early.
    //
    // Real timers here, unlike its neighbours: two deliveries in one test
    // means waiting for the store write BETWEEN them, and a faked clock does
    // not turn the event loop for real file IO.
    const queued = vi.fn(async () => ({ ok: true, acceptance: { kind: 'queue', acceptedAt: 1 } } as unknown as PromptDeliveryResult))
    const { svc, deliver } = await service(queued)
    await svc.startLoop('s1', { goal: 'G.', loopPrompt: 'P.' })
    svc.observeProviderHook('s1', 'post-tool-use')
    svc.observeProviderHook('s1', 'stop', { blocked: false })
    // Wait for the delivery to be RECORDED, not merely issued: the
    // re-entrancy guard holds until the loop's state is persisted, so a slow
    // store would otherwise swallow the second Stop and let this test pass
    // with the latch removed (#1033 round 4).
    await vi.waitFor(() => {
      expect(deliver).toHaveBeenCalledTimes(1)
      expect(svc.snapshot()['s1']?.continuationsDelivered).toBe(1)
    })

    // The turn that was already running now ends. Our continuation is still
    // in the queue, so this Stop is not ours to answer.
    svc.observeProviderHook('s1', 'stop', { blocked: false })
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(deliver).toHaveBeenCalledTimes(1)

    // The queue drains: the provider submits our prompt, which is a new turn,
    // and the end of THAT turn is the next boundary.
    svc.observeProviderHook('s1', 'user-prompt-submit')
    svc.observeProviderHook('s1', 'stop', { blocked: false })
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2))
  })

  it('a trailing event about the FINISHED turn cannot resurrect a busy phase (#1033 round 3)', async () => {
    // The seeded busy state (markOwedATurn) is only ever cleared by a provider
    // event, and a hook session whose semantic stream is absent or late never
    // sends one. Any event at all used to mark that stale seed trustworthy —
    // including one about work that had already finished — and the loop then
    // held its continuation until the 30-minute pause.
    const { svc, manager, deliver } = await service()
    vi.useFakeTimers()
    try {
      await svc.startLoop('s1', { goal: 'G.', loopPrompt: 'P.' })
      svc.observeProviderHook('s1', 'post-tool-use')
      svc.observeProviderHook('s1', 'stop', { blocked: false })
      // A late event that says nothing about the phase.
      manager.emit('semantic-event', { sessionId: 's1', event: { type: 'tool_result', toolUseId: 'gone' } })
      await vi.advanceTimersByTimeAsync(2_000)
      expect(deliver).toHaveBeenCalledTimes(1)
    } finally { vi.useRealTimers() }
  })

  it('a long TOOL run is not a stalled signal, and is not paused for one (#1033 rounds 3 and 6)', async () => {
    // A build, a test suite, an install. The provider is waiting on a tool it
    // dispatched, the process behind it is alive, and the only traffic is the
    // proxy's own flow bookkeeping. Pausing there costs the loop its turn:
    // the tool's eventual result and Stop cannot continue a paused loop.
    const { svc, manager, deliver, processState } = await service()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.useFakeTimers()
    try {
      await svc.startLoop('s1', { goal: 'G.', loopPrompt: 'P.' })
      svc.observeProviderHook('s1', 'user-prompt-submit')
      processState.active = true
      manager.emit('semantic-event', { sessionId: 's1', event: { type: 'stream_phase', phase: 'awaiting-tool', toolUseId: 'toolu_build' } })
      svc.control('s1', { action: 'pause' })
      svc.control('s1', { action: 'resume' })
      for (let minute = 0; minute < 40; minute += 1) {
        manager.emit('semantic-event', { sessionId: 's1', event: { type: 'flow_ignored', flowId: `f${minute}`, reason: 'secondary call' } })
        await vi.advanceTimersByTimeAsync(60_000)
      }
      expect(svc.snapshot()['s1']).toMatchObject({ phase: 'active' })
      expect(deliver).not.toHaveBeenCalled()

      // The tool finally returns and the turn ends.
      manager.emit('semantic-event', { sessionId: 's1', event: { type: 'tool_result', toolUseId: 'toolu_build' } })
      idleTurn(manager)
      processState.active = false
      svc.observeProviderHook('s1', 'stop', { blocked: false })
      await vi.advanceTimersByTimeAsync(2_000)
      expect(deliver).toHaveBeenCalledTimes(1)
    } finally { vi.useRealTimers(); warn.mockRestore() }
  })

  it('a hold cannot outlive the absolute limit, whatever keeps arriving (#1033 round 7)', async () => {
    // Claude's sidecar churn (flow_selected → requesting → idle →
    // flow_ignored, #1024's recorded sequence) renews the silence clock,
    // because the same phase events ARE the working signal on Grok and
    // OpenCode Terminal and cannot be filtered by type. Time is what
    // separates them: the hold has an outside edge that nothing exempts.
    const { svc, manager, deliver } = await service()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.useFakeTimers()
    try {
      await svc.startLoop('s1', { goal: 'G.', loopPrompt: 'P.' })
      svc.observeProviderHook('s1', 'user-prompt-submit')
      svc.control('s1', { action: 'pause' })
      svc.control('s1', { action: 'resume' })
      for (let minute = 0; minute < 200; minute += 1) {
        subagentFlowInToolGap(manager)
        await vi.advanceTimersByTimeAsync(60_000)
      }
      expect(deliver).not.toHaveBeenCalled()
      expect(svc.snapshot()['s1']).toMatchObject({ phase: 'paused', pauseReason: 'error' })
    } finally { vi.useRealTimers(); warn.mockRestore() }
  })

  it('a provider whose phases ARE its progress is not paused for silence (#1033 round 7)', async () => {
    // Grok and managed OpenCode Terminal publish phase transitions during a
    // turn and carry their content on a separate channel. Excluding phases
    // from progress paused those loops after thirty minutes of real work.
    const { svc, manager, deliver } = await service()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.useFakeTimers()
    try {
      await svc.startLoop('s1', { goal: 'G.', loopPrompt: 'P.' })
      svc.observeProviderHook('s1', 'user-prompt-submit')
      svc.control('s1', { action: 'pause' })
      svc.control('s1', { action: 'resume' })
      for (let minute = 0; minute < 40; minute += 1) {
        manager.emit('semantic-event', { sessionId: 's1', event: { type: 'stream_phase', phase: minute % 2 ? 'responding' : 'tool-input' } })
        await vi.advanceTimersByTimeAsync(60_000)
      }
      expect(svc.snapshot()['s1']).toMatchObject({ phase: 'active' })
      expect(deliver).not.toHaveBeenCalled()
    } finally { vi.useRealTimers(); warn.mockRestore() }
  })

  it('a hook session does not release a queued continuation on a subagent phase edge (#1033 round 4)', async () => {
    // The phase fallback exists for providers without hooks. For a hook
    // session it is the #1024 false positive itself: a Claude subagent flow
    // publishes working→idle mid-turn, which released the latch and delivered
    // a second continuation with no UserPromptSubmit in sight.
    const queued = vi.fn(async () => ({ ok: true, acceptance: { kind: 'queue', acceptedAt: 1 } } as unknown as PromptDeliveryResult))
    const { svc, manager, deliver } = await service(queued)
    await svc.startLoop('s1', { goal: 'G.', loopPrompt: 'P.' })
    svc.observeProviderHook('s1', 'post-tool-use')
    svc.observeProviderHook('s1', 'stop', { blocked: false })
    await vi.waitFor(() => expect(svc.snapshot()['s1']?.continuationsDelivered).toBe(1))

    // The turn that was already running ends, so the continuation is held on
    // the queue latch alone — the Stop cleared the turn guard and the tracked
    // phase with it.
    svc.observeProviderHook('s1', 'stop', { blocked: false })
    // Now the recorded subagent sequence: a flow promoted on its first chunk
    // and demoted as a subagent, which reads as working→idle. The hold poll
    // re-evaluates every second, so a latch released by that edge delivers
    // with no further hook at all.
    subagentFlowInToolGap(manager)
    await new Promise(resolve => setTimeout(resolve, 1_500))
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it('a stall pause drops the queue latch so Resume can act (#1033 round 4)', async () => {
    // The queued prompt never started — the user cleared the queue, or the
    // start signal never came. Pausing while KEEPING the latch made Resume
    // useless: it re-held on the same stale reason and paused again half an
    // hour later, forever, without delivering.
    const queued = vi.fn(async () => ({ ok: true, acceptance: { kind: 'queue', acceptedAt: 1 } } as unknown as PromptDeliveryResult))
    const { svc, deliver } = await service(queued)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await svc.startLoop('s1', { goal: 'G.', loopPrompt: 'P.' })
    svc.observeProviderHook('s1', 'post-tool-use')
    svc.observeProviderHook('s1', 'stop', { blocked: false })
    await vi.waitFor(() => expect(svc.snapshot()['s1']?.continuationsDelivered).toBe(1))

    vi.useFakeTimers()
    try {
      svc.observeProviderHook('s1', 'stop', { blocked: false })
      await vi.advanceTimersByTimeAsync(GOAL_LOOP_HOLD_STALL_MS + 2_000)
      expect(svc.snapshot()['s1']).toMatchObject({ phase: 'paused', pauseReason: 'error' })
    } finally { vi.useRealTimers(); warn.mockRestore() }

    svc.control('s1', { action: 'resume' })
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2))
  })

  it('a streamed answer is progress, not silence (#1033 round 4)', async () => {
    // A streamed answer is mostly text and thinking deltas, which the reducer
    // collapses to the same state. Treating only state CHANGES as progress
    // paused a loop for "silence" through forty minutes of visible streaming.
    const { svc, manager, deliver } = await service()
    vi.useFakeTimers()
    try {
      await svc.startLoop('s1', { goal: 'G.', loopPrompt: 'P.' })
      svc.observeProviderHook('s1', 'user-prompt-submit')
      svc.control('s1', { action: 'pause' })
      svc.control('s1', { action: 'resume' })
      manager.emit('semantic-event', { sessionId: 's1', event: { type: 'stream_phase', phase: 'responding' } })
      for (let minute = 0; minute < 40; minute += 1) {
        manager.emit('semantic-event', { sessionId: 's1', event: { type: 'text_delta', text: 'still going' } })
        await vi.advanceTimersByTimeAsync(60_000)
      }
      expect(svc.snapshot()['s1']).toMatchObject({ phase: 'active' })
      expect(deliver).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })

  it('unrelated traffic cannot renew the screen grace (#1033 round 4)', async () => {
    // The screen is the signal that latches on a stale row, so the time it is
    // allowed to hold a delivery must be a real bound — not one any passing
    // event can renew. With a latched active screen and an idle phase, turn
    // metadata arriving every 30 s held a continuation forever.
    const { svc, manager, deliver, processState } = await service()
    vi.useFakeTimers()
    try {
      await svc.startLoop('s1', { goal: 'G.', loopPrompt: 'P.' })
      processState.active = true
      idleTurn(manager)
      for (let tick = 0; tick < 4; tick += 1) {
        manager.emit('semantic-event', { sessionId: 's1', event: { type: 'turn_started', turnId: `t${tick}` } })
        manager.emit('semantic-event', { sessionId: 's1', event: { type: 'turn_completed', turnId: `t${tick}` } })
        await vi.advanceTimersByTimeAsync(30_000)
      }
      expect(deliver).toHaveBeenCalledTimes(1)
    } finally { vi.useRealTimers() }
  })

  it('flow bookkeeping is not progress, so it cannot postpone a stall forever (#1033 round 5)', async () => {
    // `flow_selected` / `flow_ignored` report which upstream call the proxy
    // renders from — title generation, a retry, a subagent's stream. They say
    // nothing about THIS agent working, and one a minute kept a stale hold
    // alive for two simulated hours with zero deliveries.
    const { svc, manager, deliver } = await service()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.useFakeTimers()
    try {
      await svc.startLoop('s1', { goal: 'G.', loopPrompt: 'P.' })
      svc.observeProviderHook('s1', 'user-prompt-submit')
      svc.control('s1', { action: 'pause' })
      svc.control('s1', { action: 'resume' })
      for (let minute = 0; minute < 40; minute += 1) {
        manager.emit('semantic-event', { sessionId: 's1', event: { type: 'flow_ignored', flowId: `f${minute}`, reason: 'secondary call' } })
        await vi.advanceTimersByTimeAsync(60_000)
      }
      expect(deliver).not.toHaveBeenCalled()
      expect(svc.snapshot()['s1']).toMatchObject({ phase: 'paused', pauseReason: 'error' })
    } finally { vi.useRealTimers(); warn.mockRestore() }
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
    const manager = Object.assign(new EventEmitter(), { deliverPromptToAgent: vi.fn(), getProcessStateSnapshot: () => ({ active: false }) })
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
    const manager = Object.assign(new EventEmitter(), { deliverPromptToAgent: vi.fn(), getProcessStateSnapshot: () => ({ active: false }) })
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
    const svc = new GoalLoopService({ manager: Object.assign(new EventEmitter(), { deliverPromptToAgent: vi.fn(), getProcessStateSnapshot: () => ({ active: false }) }), store })
    await svc.start()
    warn.mockRestore()
    // start() persists immediately, which used to replace the bad file.
    expect(await readFile(store.quarantineFile, 'utf8')).toBe('{broken')
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 1, loops: {} })
  })
  it('keeps the valid loops live, and never writes over the only copy, while an unreadable loop cannot be preserved (q18, q19)', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-code-goal-loop-'))
    directories.push(directory)
    const file = join(directory, 'goal-loop.json')
    const fixture = JSON.parse(await readFile(join(import.meta.dirname,
      '../../../testing/fixtures/goal-loop/real-loops-2026-09-25.json'), 'utf8')) as { document: { version: 1; loops: Record<string, { phase: string }> } }
    const [newer, kept] = Object.keys(fixture.document.loops)
    fixture.document.loops[newer!]!.phase = 'waiting-on-review'
    const source = JSON.stringify(fixture.document)
    await writeFile(file, source)
    // Both preservation targets are obstructed (here by directories), as any
    // unwritable location would be.
    const digest = createHash('sha256').update(source).digest('hex').slice(0, 16)
    const copyPath = join(directory, `goal-loop.json.invalid-${digest}.json`)
    await mkdir(copyPath)
    await mkdir(join(directory, 'goal-loop.json.corrupt'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = new GoalLoopStore(file)
    const svc = new GoalLoopService({ manager: Object.assign(new EventEmitter(), { deliverPromptToAgent: vi.fn(), getProcessStateSnapshot: () => ({ active: false }) }), store })
    await svc.start()
    // The valid loop is live; the unreadable one is not.
    expect(Object.keys(svc.snapshot())).toEqual([kept])
    // start() persisted, and that write was refused: the only copy of the
    // unreadable loop is still the live file.
    expect(await readFile(file, 'utf8')).toBe(source)

    // The obstruction clears; the next persist makes the copy and then writes
    // the live state, which still holds the valid loop.
    await rm(copyPath, { recursive: true })
    await store.write(svc.snapshot())
    warn.mockRestore()
    expect(await readFile(copyPath, 'utf8')).toBe(source)
    expect(Object.keys(JSON.parse(await readFile(file, 'utf8')).loops)).toEqual([kept])
  })

  it('keeps a malformed file in place when its quarantine name cannot take it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-code-goal-loop-'))
    directories.push(directory)
    const file = join(directory, 'goal-loop.json')
    await writeFile(file, '{broken')
    await mkdir(join(directory, 'goal-loop.json.corrupt'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const svc = new GoalLoopService({ manager: Object.assign(new EventEmitter(), { deliverPromptToAgent: vi.fn(), getProcessStateSnapshot: () => ({ active: false }) }), store: new GoalLoopStore(file) })
    await svc.start()
    warn.mockRestore()
    expect(await readFile(file, 'utf8')).toBe('{broken')
  })

  it('rejects a second concurrent loop and a complete with no loop', async () => {
    const { svc } = await service()
    await svc.startLoop('s1', { goal: 'G.', loopPrompt: 'P.' })
    await expect(svc.startLoop('s1', { goal: 'G2.', loopPrompt: 'P.' })).rejects.toThrow('already')
    await expect(svc.complete('other', 'done', 'x.')).rejects.toThrow('No goal loop')
  })
})

describe('GoalLoopService idle-blip retraction', () => {
  // Claude's adapter clears a mis-promoted 'requesting' sidecar phase by
  // publishing a brief 'idle' mid-turn (ClaudeProxyAdapter.ts "Publish
  // phase: 'idle' to clear the brief requesting"), and a poll batch can carry
  // the blip and its retraction together. Deciding synchronously on the
  // working→idle transition delivered a continuation into a live turn.
  it('does not deliver on a mid-turn idle blip the same batch retracts', async () => {
    const { svc, manager, deliver } = await service()
    await svc.startLoop('s1', { goal: 'G.', loopPrompt: 'P.' })
    manager.emit('semantic-event', { sessionId: 's1', event: { type: 'stream_phase', phase: 'idle' } })
    manager.emit('semantic-event', { sessionId: 's1', event: { type: 'stream_phase', phase: 'requesting' } })
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(deliver).not.toHaveBeenCalled()
    expect(svc.snapshot()['s1']?.phase).toBe('active')
  })
  it('does not deliver while a tool result is still owed after an idle phase', async () => {
    const { svc, manager, deliver } = await service()
    await svc.startLoop('s1', { goal: 'G.', loopPrompt: 'P.' })
    manager.emit('semantic-event', { sessionId: 's1', event: { type: 'block_started', kind: 'tool_use', toolUseId: 't1' } })
    manager.emit('semantic-event', { sessionId: 's1', event: { type: 'stream_phase', phase: 'idle' } })
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(deliver).not.toHaveBeenCalled()
  })
})

describe('GoalLoopService turn boundary from provider hooks (#1024)', () => {
  const settle = () => new Promise(resolve => setTimeout(resolve, 20))
  // subagentFlowInToolGap (module level) is the recorded pre-delivery edge.

  it('ignores the recorded subagent-flow idle edge once the session has hooks, and continues on the allowed Stop', async () => {
    const { svc, manager, deliver } = await service()
    await svc.startLoop('s1', { goal: 'G.', loopPrompt: 'P.' })
    // goal_loop_start is itself a tool call, so its PostToolUse hook arrives
    // before the turn that started the loop can end. That proves the hooks work.
    svc.observeProviderHook('s1', 'post-tool-use')
    subagentFlowInToolGap(manager)
    await settle()
    expect(deliver).not.toHaveBeenCalled()
    svc.observeProviderHook('s1', 'stop', { blocked: false })
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1))
  })

  it('control: a session without hooks keeps the phase fallback (unchanged for OpenCode and Grok)', async () => {
    const { svc, manager, deliver } = await service()
    await svc.startLoop('s1', { goal: 'G.', loopPrompt: 'P.' })
    manager.emit('semantic-event', { sessionId: 's1', event: { type: 'stream_phase', phase: 'requesting' } })
    idleTurn(manager)
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1))
  })

  it('a Stop that TLDR enforcement blocked is not a boundary; the allowed Stop after it is', async () => {
    const { svc, deliver } = await service()
    await svc.startLoop('s1', { goal: 'G.', loopPrompt: 'P.' })
    svc.observeProviderHook('s1', 'post-tool-use')
    svc.observeProviderHook('s1', 'stop', { blocked: true })
    await settle()
    expect(deliver).not.toHaveBeenCalled()
    svc.observeProviderHook('s1', 'stop', { blocked: false })
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1))
    await settle()
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it('its own delivery opens a turn: later subagent traffic cannot re-deliver before the next Stop', async () => {
    const { svc, manager, deliver } = await service()
    await svc.startLoop('s1', { goal: 'G.', loopPrompt: 'P.' })
    svc.observeProviderHook('s1', 'post-tool-use')
    svc.observeProviderHook('s1', 'stop', { blocked: false })
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1))
    // The recorded doubles (#1/#2 0.4 s apart) came from exactly this.
    subagentFlowInToolGap(manager)
    subagentFlowInToolGap(manager)
    await settle()
    expect(deliver).toHaveBeenCalledTimes(1)
    svc.observeProviderHook('s1', 'stop', { blocked: false })
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2))
  })

  it('resume during an open hook turn waits for that turn to Stop, even when the phase reads idle', async () => {
    const { svc, manager, deliver } = await service()
    await svc.startLoop('s1', { goal: 'G.', loopPrompt: 'P.' })
    svc.observeProviderHook('s1', 'post-tool-use')
    // The recorded subagent edge leaves the phase-derived state idle in the
    // middle of the turn. The phase gate would take Resume as permission to
    // prompt the busy agent here (#1028 review: the old version of this test
    // passed under that gate too, because startLoop leaves the phase busy).
    subagentFlowInToolGap(manager)
    svc.control('s1', { action: 'pause' })
    svc.control('s1', { action: 'resume' })
    await settle()
    expect(deliver).not.toHaveBeenCalled()
    svc.observeProviderHook('s1', 'stop', { blocked: false })
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1))
  })

  it('a Stop that lands while its own continuation is still being delivered does not deliver a second one', async () => {
    // The parked-trigger case markOwedATurn's open-turn mark exists for: the
    // Stop parks behind the in-flight delivery, and when that delivery
    // succeeds it opens the turn it started, so the parked check finds a busy
    // agent. Without the mark it delivered again at once.
    let accept!: (result: PromptDeliveryResult) => void
    const deliver = vi.fn(() => new Promise<PromptDeliveryResult>(resolve => { accept = resolve }))
    const { svc } = await service(deliver as unknown as Deliver)
    await svc.startLoop('s1', { goal: 'G.', loopPrompt: 'P.' })
    svc.observeProviderHook('s1', 'post-tool-use')
    svc.observeProviderHook('s1', 'stop', { blocked: false })
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1))
    // A late duplicate Stop for the turn that just ended (the provider retried
    // the hook) arrives while the continuation is in flight.
    svc.observeProviderHook('s1', 'stop', { blocked: false })
    await settle()
    accept({ ok: true } as PromptDeliveryResult)
    await vi.waitFor(() => expect(svc.snapshot()['s1']?.continuationsDelivered).toBe(1))
    await settle()
    expect(deliver).toHaveBeenCalledTimes(1)
  })
})

describe('GoalLoopService hook turns that end without a Stop (#1028 review)', () => {
  // Claude runs no Stop hook on an Esc interrupt, a model or API error, or
  // prompt-too-long. Codex runs none on interrupt or on turn errors. The
  // sequence below is the first review's Probe A: hooks proven, a tool
  // finished, the turn completed, and then silence. The re-review's probes
  // (Codex reasoning with no summary deltas, a long tool, Resume during a
  // running tool) are the busy cases Resume must NOT mistake for it.
  afterEach(() => { vi.useRealTimers() })
  const hookTurn = async () => {
    const ctx = await service()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    await ctx.svc.startLoop('s1', { goal: 'G.', loopPrompt: 'P.' })
    ctx.svc.observeProviderHook('s1', 'post-tool-use')
    return ctx
  }
  const pauseResume = (svc: GoalLoopService) => {
    svc.control('s1', { action: 'pause' })
    svc.control('s1', { action: 'resume' })
  }

  it('never pauses or prompts on its own: the next user prompt is the boundary', async () => {
    const { svc, manager, deliver } = await hookTurn()
    idleTurn(manager)
    await vi.advanceTimersByTimeAsync(10 * GOAL_LOOP_QUIET_TURN_MS)
    // The first review fix paused here; the re-review showed that also paused
    // turns that were still working, so silence alone decides nothing.
    expect(svc.snapshot()['s1']?.phase).toBe('active')
    expect(deliver).not.toHaveBeenCalled()
    svc.observeProviderHook('s1', 'user-prompt-submit')
    svc.observeProviderHook('s1', 'stop', { blocked: false })
    await vi.advanceTimersByTimeAsync(0)
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1))
  })

  it('Resume continues a turn that is idle, has nothing pending and has been silent for the window', async () => {
    const { svc, manager, deliver } = await hookTurn()
    idleTurn(manager)
    await vi.advanceTimersByTimeAsync(GOAL_LOOP_QUIET_TURN_MS + 1_000)
    pauseResume(svc)
    await vi.advanceTimersByTimeAsync(0)
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1))
  })

  it('Resume never prompts an agent whose tool is still running, however long it has run', async () => {
    const { svc, manager, deliver } = await hookTurn()
    manager.emit('semantic-event', { sessionId: 's1', event: { type: 'block_started', kind: 'tool_use', toolUseId: 'npm-test' } })
    // The recorded #1024 edge: a subagent flow during the tool leaves the
    // phase idle, so only the pending tool says the turn is still running.
    subagentFlowInToolGap(manager)
    await vi.advanceTimersByTimeAsync(3 * GOAL_LOOP_QUIET_TURN_MS)
    pauseResume(svc)
    await vi.advanceTimersByTimeAsync(0)
    expect(deliver).not.toHaveBeenCalled()
    // The tool finishes and the turn Stops: exactly one continuation.
    manager.emit('semantic-event', { sessionId: 's1', event: { type: 'tool_result', toolUseId: 'npm-test' } })
    svc.observeProviderHook('s1', 'stop', { blocked: false })
    await vi.advanceTimersByTimeAsync(0)
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(100)
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it('Resume never prompts during silent reasoning (Codex streams no summary for minutes)', async () => {
    const { svc, manager, deliver } = await hookTurn()
    manager.emit('semantic-event', { sessionId: 's1', event: { type: 'stream_phase', phase: 'thinking' } })
    await vi.advanceTimersByTimeAsync(2 * GOAL_LOOP_QUIET_TURN_MS)
    pauseResume(svc)
    await vi.advanceTimersByTimeAsync(0)
    expect(deliver).not.toHaveBeenCalled()
    svc.observeProviderHook('s1', 'stop', { blocked: false })
    await vi.advanceTimersByTimeAsync(0)
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1))
  })

  it('a prompt the user types while the loop is paused starts a busy turn that Resume will not interrupt', async () => {
    // #1028 re-review probe G: UserPromptSubmit publishes no semantic event,
    // so the phase still read the previous turn's idle. A silent first
    // request (a 529 retry backoff) then let Resume deliver into the turn.
    // (Reached WITHOUT a prior delivery on purpose: a delivery's persist
    // holds the re-entrancy guard and would park Resume's continuation,
    // hiding a wrong delivery behind timing.)
    const { svc, manager, deliver } = await hookTurn()
    manager.emit('semantic-event', { sessionId: 's1', event: { type: 'stream_phase', phase: 'idle' } })
    svc.control('s1', { action: 'pause' })
    svc.observeProviderHook('s1', 'user-prompt-submit')
    await vi.advanceTimersByTimeAsync(GOAL_LOOP_QUIET_TURN_MS + 1_000)
    svc.control('s1', { action: 'resume' })
    await vi.advanceTimersByTimeAsync(0)
    expect(deliver).not.toHaveBeenCalled()
    // That turn's own Stop continues the loop.
    svc.observeProviderHook('s1', 'stop', { blocked: false })
    await vi.advanceTimersByTimeAsync(0)
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1))
  })

  it('an Esc mid-stream now ends the phase, and Resume recovers the loop (#1040)', async () => {
    // This used to be pinned as a KNOWN LIMIT: an Esc left the proxy phase at
    // `thinking` forever, because mitmproxy reports a client disconnect only
    // through its `error` hook and the addon did not implement one, so no
    // `response-end` ever arrived. Resume could not close that turn and only
    // a typed prompt recovered the loop.
    //
    // claude-code-headless#61 gives that flow an ending, so the phase reaches
    // idle like any other severed stream, and Resume does its job.
    const { svc, manager, deliver } = await hookTurn()
    manager.emit('semantic-event', { sessionId: 's1', event: { type: 'stream_phase', phase: 'thinking' } })
    // The adapter seals the flow: turn stopped, phase idle.
    manager.emit('semantic-event', { sessionId: 's1', event: { type: 'turn_stopped', interruption: 'transport-error' } })
    manager.emit('semantic-event', { sessionId: 's1', event: { type: 'stream_phase', phase: 'idle' } })
    await vi.advanceTimersByTimeAsync(2 * GOAL_LOOP_QUIET_TURN_MS)

    svc.control('s1', { action: 'pause' })
    svc.control('s1', { action: 'resume' })
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1))
  })

  it('any traffic restarts the silence, including events that change nothing', async () => {
    // A stream of identical events returns early from the reducer; the
    // activity stamp must happen before that return.
    const { svc, manager, deliver } = await hookTurn()
    idleTurn(manager)
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(GOAL_LOOP_QUIET_TURN_MS / 2)
      idleTurn(manager)
    }
    await vi.advanceTimersByTimeAsync(GOAL_LOOP_QUIET_TURN_MS / 2)
    pauseResume(svc)
    await vi.advanceTimersByTimeAsync(0)
    expect(deliver).not.toHaveBeenCalled()
  })

  it('a hook restarts the silence', async () => {
    const { svc, manager, deliver } = await hookTurn()
    idleTurn(manager)
    await vi.advanceTimersByTimeAsync(GOAL_LOOP_QUIET_TURN_MS - 10_000)
    svc.observeProviderHook('s1', 'post-tool-use')
    await vi.advanceTimersByTimeAsync(20_000)
    pauseResume(svc)
    await vi.advanceTimersByTimeAsync(0)
    expect(deliver).not.toHaveBeenCalled()
  })

  it('Resume right after our own delivery waits for that turn', async () => {
    const { svc, manager, deliver } = await hookTurn()
    idleTurn(manager)
    svc.observeProviderHook('s1', 'stop', { blocked: false })
    await vi.advanceTimersByTimeAsync(0)
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1))
    // The continuation's turn has just started, so a Resume 30 s in, after
    // the previous turn's silence, must not deliver a second one.
    await vi.advanceTimersByTimeAsync(GOAL_LOOP_QUIET_TURN_MS / 2)
    pauseResume(svc)
    await vi.advanceTimersByTimeAsync(0)
    expect(deliver).toHaveBeenCalledTimes(1)
  })
})

// Real Stop hook bodies from Claude Code 2.1.282 (#1138), captured unedited
// with a command Stop hook in headless runs. `background_tasks` is the CLI's
// own "paused waiting for background work to wake it" signal.
const recordedStops = JSON.parse(readFileSync(
  new URL('../../../testing/fixtures/goal-loop-stop-hooks/claude-2.1.282.json', import.meta.url),
  'utf8',
)) as Record<'nothingPending' | 'backgroundShellRunning' | 'asyncSubagentRunning' | 'afterSubagentFinishedLeftoverShell', { background_tasks: Array<{ type: string; status: string }> }>

describe('GoalLoopService and background work the agent is waiting on (#1138)', () => {
  const stopWith = (svc: GoalLoopService, body: { background_tasks?: Array<{ type: string; status: string }> }) =>
    svc.observeProviderHook('s1', 'stop', { blocked: false, backgroundTasks: body.background_tasks })

  it('holds the continuation while a background shell the agent launched is running', async () => {
    const { svc, deliver } = await service()
    await svc.startLoop('s1', { goal: 'G.', loopPrompt: 'P.' })
    svc.observeProviderHook('s1', 'user-prompt-submit')
    stopWith(svc, recordedStops.backgroundShellRunning)
    await new Promise(resolve => setTimeout(resolve, 20))
    // Observed live 2026-09-22: continuations delivered here got "still
    // waiting" and burned the budget.
    expect(deliver).not.toHaveBeenCalled()
    expect(svc.snapshot()['s1']).toMatchObject({ phase: 'active' })

    // The task-notification wakes the agent; that turn's Stop has nothing left.
    svc.observeProviderHook('s1', 'user-prompt-submit')
    stopWith(svc, recordedStops.nothingPending)
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1))
  })

  it('holds for an async subagent too', async () => {
    const { svc, deliver } = await service()
    await svc.startLoop('s1', { goal: 'G.', loopPrompt: 'P.' })
    svc.observeProviderHook('s1', 'user-prompt-submit')
    stopWith(svc, recordedStops.asyncSubagentRunning)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(deliver).not.toHaveBeenCalled()
  })

  it('continues as before when the CLI does not report background work at all', async () => {
    // An older CLI sends no field. Missing means unknown, not "none", and
    // unknown keeps today's behaviour.
    const { svc, deliver } = await service()
    await svc.startLoop('s1', { goal: 'G.', loopPrompt: 'P.' })
    svc.observeProviderHook('s1', 'user-prompt-submit')
    stopWith(svc, {})
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1))
  })

  it('does not hold on a monitor_mcp/monitor_ws task, which never finishes', async () => {
    // The CLI names those two task kinds "monitor" on the wire. The Monitor
    // TOOL is not one of them: it arrives as "shell" (see the persistent
    // monitor case below).
    const { svc, deliver } = await service()
    await svc.startLoop('s1', { goal: 'G.', loopPrompt: 'P.' })
    svc.observeProviderHook('s1', 'user-prompt-submit')
    stopWith(svc, { background_tasks: [{ type: 'monitor', status: 'running' }] })
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1))
  })

  // Every wire name the loop holds on, spelled as 2.1.282's own type map
  // spells it (local_workflow→"workflow", mcp_task→"MCP task"), and the
  // "pending" status the CLI's filter also emits. A typo in any of them
  // degrades silently to no hold, so each is pinned here.
  it.each([
    ['workflow', 'running'],
    ['MCP task', 'running'],
    ['shell', 'pending'],
  ])('holds for a %s task that is %s', async (type, status) => {
    const { svc, deliver } = await service()
    await svc.startLoop('s1', { goal: 'G.', loopPrompt: 'P.' })
    svc.observeProviderHook('s1', 'user-prompt-submit')
    stopWith(svc, { background_tasks: [{ type, status }] })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(deliver).not.toHaveBeenCalled()
  })

  it('keeps holding when the notification turn ends with a leftover shell still running', async () => {
    // The recorded case: the subagent's notification turn ended while a shell
    // the agent had started earlier was still listed. Each Stop REPLACES the
    // report, so the hold survives until a Stop lists nothing.
    const { svc, deliver } = await service()
    await svc.startLoop('s1', { goal: 'G.', loopPrompt: 'P.' })
    svc.observeProviderHook('s1', 'user-prompt-submit')
    stopWith(svc, recordedStops.asyncSubagentRunning)
    svc.observeProviderHook('s1', 'user-prompt-submit')
    stopWith(svc, recordedStops.afterSubagentFinishedLeftoverShell)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(deliver).not.toHaveBeenCalled()
    svc.observeProviderHook('s1', 'user-prompt-submit')
    stopWith(svc, recordedStops.nothingPending)
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1))
  })

  it('keeps the hold when a Stop arrives without a readable report', async () => {
    // An unparseable Stop body is forwarded blind so the turn end is not
    // missed. Reading it as "nothing running" typed the continuation into
    // the very gap the hold protects (#1224 review).
    const { svc, deliver } = await service()
    await svc.startLoop('s1', { goal: 'G.', loopPrompt: 'P.' })
    svc.observeProviderHook('s1', 'user-prompt-submit')
    stopWith(svc, recordedStops.backgroundShellRunning)
    stopWith(svc, {})
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(deliver).not.toHaveBeenCalled()
  })

  it('drops the hold when the process dies, so a restarted session is not born held', async () => {
    const { svc, manager, deliver } = await service()
    await svc.startLoop('s1', { goal: 'G.', loopPrompt: 'P.' })
    svc.observeProviderHook('s1', 'user-prompt-submit')
    stopWith(svc, recordedStops.backgroundShellRunning)
    manager.emit('exit', { sessionId: 's1' })
    expect(svc.snapshot()['s1']).toMatchObject({ phase: 'paused', pauseReason: 'interrupted' })
    svc.control('s1', { action: 'resume' })
    idleTurn(manager)
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1))
  })

  describe('bounded by GOAL_LOOP_BACKGROUND_WORK_LIMIT_MS', () => {
    let warn: ReturnType<typeof vi.spyOn>
    afterEach(() => { vi.useRealTimers(); warn.mockRestore() })

    it('waits out a long background agent without a silence pause', async () => {
      // Background implementers routinely run 20–40 minutes with no turn in
      // between. A stall pause would leave the loop paused when the
      // notification turn arrives, so nothing would continue it.
      const { svc, deliver } = await service()
      warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.useFakeTimers()
      await svc.startLoop('s1', { goal: 'G.', loopPrompt: 'P.' })
      svc.observeProviderHook('s1', 'user-prompt-submit')
      stopWith(svc, recordedStops.asyncSubagentRunning)
      await vi.advanceTimersByTimeAsync(GOAL_LOOP_HOLD_STALL_MS + 5 * 60_000)
      expect(deliver).not.toHaveBeenCalled()
      expect(svc.snapshot()['s1']).toMatchObject({ phase: 'active' })
    })

    it('keeps an unattended loop moving beside a shell that never ends (a persistent Monitor)', async () => {
      // The Monitor tool is a local_bash task, so 2.1.282 reports it as
      // "shell" with no kind: the loop cannot tell it from a build. Under the
      // absolute limit alone this parked the loop for two hours, paused it as
      // an error, and re-parked it after every Resume. Now each report
      // expires, a continuation lands (at worst the agent says "still
      // waiting" once), and the loop never pauses.
      const persistentMonitor = { background_tasks: [{ type: 'shell', status: 'running' }] }
      const { svc, deliver, storePath } = await service()
      warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.useFakeTimers()
      await svc.startLoop('s1', { goal: 'G.', loopPrompt: 'P.' })
      svc.observeProviderHook('s1', 'user-prompt-submit')
      stopWith(svc, persistentMonitor)
      await vi.advanceTimersByTimeAsync(GOAL_LOOP_BACKGROUND_WORK_LIMIT_MS - 60_000)
      expect(deliver).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(2 * 60_000)
      expect(deliver).toHaveBeenCalledTimes(1)
      // The delivery persists the loop with real file I/O, which fake timers
      // never advance; until it lands the service parks new triggers. Let it
      // finish, as it would in the minutes a real turn takes.
      await vi.waitFor(() => expect(readFileSync(storePath, 'utf8')).toMatch(/"continuationsDelivered":\s*1/))

      // The continuation's own turn ends with the monitor still listed: a
      // fresh window, not an immediate second prompt, and still no pause.
      svc.observeProviderHook('s1', 'user-prompt-submit')
      stopWith(svc, persistentMonitor)
      await vi.advanceTimersByTimeAsync(GOAL_LOOP_BACKGROUND_WORK_LIMIT_MS - 60_000)
      expect(deliver).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(2 * 60_000)
      expect(deliver).toHaveBeenCalledTimes(2)
      expect(svc.snapshot()['s1']).toMatchObject({ phase: 'active' })
    })

    it('stops exempting a later silent turn from the stall pause once the report expires', async () => {
      // The notification turn starts and then ends through Esc or an API
      // error, which fire no Stop. The report is stale, and it used to keep
      // suppressing the 30-minute silence pause until the 2-hour limit.
      const { svc } = await service()
      warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.useFakeTimers()
      await svc.startLoop('s1', { goal: 'G.', loopPrompt: 'P.' })
      svc.observeProviderHook('s1', 'user-prompt-submit')
      stopWith(svc, recordedStops.backgroundShellRunning)
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      svc.observeProviderHook('s1', 'user-prompt-submit')
      await vi.advanceTimersByTimeAsync(GOAL_LOOP_BACKGROUND_WORK_LIMIT_MS)
      expect(svc.snapshot()['s1']).toMatchObject({ phase: 'paused', pauseReason: 'error' })
      expect(GOAL_LOOP_BACKGROUND_WORK_LIMIT_MS + 10 * 60_000).toBeLessThan(GOAL_LOOP_HOLD_LIMIT_MS)
    })
  })
})
