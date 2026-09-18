import { EventEmitter } from 'node:events'
import type { SessionManager } from '@main/sessionManager.js'
import { buildGoalLoopContinuationPrompt } from '@mcp/shared/goalLoopPrompt.js'
import { INITIAL_WORKING_STATE, isWorking, reduceWorkingState } from '@shared/agentActivity/workingState.js'
import type { WorkingState } from '@shared/agentActivity/workingState.js'
import type { GoalLoopState } from '@shared/types/goalLoop.js'
import { GOAL_LOOP_DEFAULT_MAX_CONTINUATIONS, GOAL_LOOP_MAX_CONTINUATIONS_CEILING } from '@shared/types/goalLoop.js'
import { GOAL_LOOP_STORE_LIMIT, GoalLoopStore } from './GoalLoopStore.js'

const MAX_DELIVERY_FAILURES = 3
const DELIVERY_RETRY_DELAY_MS = 250

type GoalLoopManagerPort = Pick<SessionManager, 'on'> & {
  deliverPromptToAgent: SessionManager['deliverPromptToAgent']
}

/** The harness-owned goal loop (#1001).
 *
 * WHY main-process and not a provider Stop hook: Claude Code force-stops
 * after 9 consecutive Stop-hook blocks, so hook-driven persistence modes die
 * young (oh-my-claudecode #3138), and OpenCode has no block-capable Stop hook
 * at all. We own deliverPromptToAgent and observe every turn boundary here,
 * so the loop is provider-agnostic and unbounded by provider overrides.
 *
 * WHY attention/conditions are NOT subscribed: a permission prompt parks the
 * agent on the USER's decision; delivering a continuation behind that dialog
 * would queue a prompt the user never saw. The loop continues only after a
 * semantic working→idle transition.
 *
 * Re-entrancy: delivery is awaited, so a second turn_completed during the
 * await is dropped via `continuing`; deliverPromptToAgent's own in-flight
 * mutual exclusion inside SessionManager is the second gate.
 */
export class GoalLoopService extends EventEmitter {
  private readonly loops = new Map<string, GoalLoopState>()
  private readonly working = new Map<string, WorkingState>()
  private readonly continuing = new Set<string>()
  /** A continuation requested while another was still finishing (e.g. resume
   * racing the tail of a cap-pause write). The in-flight run picks it up in
   * its finally block, so a control action can never be silently dropped. */
  private readonly pendingContinue = new Set<string>()

  constructor(private readonly deps: {
    manager: GoalLoopManagerPort
    store: GoalLoopStore
    now?: () => Date
  }) { super() }

  async start(): Promise<void> {
    const persisted = await this.deps.store.read().catch(error => {
      console.warn('[goal-loop] persisted state unreadable; starting empty:', error)
      return {}
    })
    const now = this.now().toISOString()
    for (const [sessionId, loop] of Object.entries(persisted)) {
      // An app restart severed the observation the loop depends on; never
      // blind-continue a loop the user did not re-arm (spec: conservative v1).
      this.loops.set(sessionId, loop.phase === 'active'
        ? { ...loop, phase: 'paused', pauseReason: 'interrupted', updatedAt: now }
        : loop)
    }
    const { manager } = this.deps
    manager.on('semantic-event', ({ sessionId, event }: { sessionId: string; event: unknown }) => {
      this.signal(sessionId, event)
    })
    // `removed` is the reliable end (forwarder.ts); `exit` can precede it.
    manager.on('removed', ({ sessionId }: { sessionId: string }) => this.interrupt(sessionId))
    manager.on('exit', ({ sessionId }: { sessionId: string }) => this.interrupt(sessionId))
    await this.persist()
  }

  snapshot(): Record<string, GoalLoopState> {
    return Object.fromEntries([...this.loops.entries()].map(([id, loop]) => [id, { ...loop }]))
  }

  async startLoop(sessionId: string, input: { goal: string; loopPrompt: string; maxContinuations?: number }): Promise<GoalLoopState> {
    const existing = this.loops.get(sessionId)
    if (existing && existing.phase !== 'ended') throw new Error('A goal loop is already active for this session. Complete or stop it first.')
    const now = this.now().toISOString()
    const loop: GoalLoopState = {
      sessionId, goal: input.goal.trim(), loopPrompt: input.loopPrompt.trim(),
      phase: 'active', pauseReason: null, endReason: null, completionSummary: null,
      maxContinuations: Math.min(input.maxContinuations ?? GOAL_LOOP_DEFAULT_MAX_CONTINUATIONS, GOAL_LOOP_MAX_CONTINUATIONS_CEILING),
      continuationsDelivered: 0, consecutiveDeliveryFailures: 0, startedAt: now, updatedAt: now,
    }
    this.loops.set(sessionId, loop)
    // Seed as working: goal_loop_start is a tool call INSIDE the running turn,
    // so the first turn_completed must land on a responding state or the
    // working→idle transition that triggers continuation #1 never fires.
    this.working.set(sessionId, { ...INITIAL_WORKING_STATE, phase: 'responding' })
    await this.persist()
    return { ...loop }
  }

  async complete(sessionId: string, outcome: 'done' | 'blocked', summary: string): Promise<GoalLoopState> {
    const loop = this.loops.get(sessionId)
    if (!loop || loop.phase === 'ended') throw new Error('No goal loop is active for this session.')
    const ended: GoalLoopState = {
      ...loop, phase: 'ended', endReason: outcome, completionSummary: summary.trim(),
      pauseReason: null, updatedAt: this.now().toISOString(),
    }
    this.loops.set(sessionId, ended)
    await this.persist()
    return { ...ended }
  }

  control(sessionId: string, command: { action: 'pause' | 'resume' | 'stop' | 'raise-cap'; value?: number }): GoalLoopState | null {
    const loop = this.loops.get(sessionId)
    if (!loop) return null
    const now = this.now().toISOString()
    if (command.action === 'pause' && loop.phase === 'active') {
      this.loops.set(sessionId, { ...loop, phase: 'paused', pauseReason: 'user', updatedAt: now })
    } else if (command.action === 'stop' && loop.phase !== 'ended') {
      this.loops.set(sessionId, { ...loop, phase: 'ended', endReason: 'cancelled', pauseReason: null, updatedAt: now })
    } else if (command.action === 'raise-cap') {
      const raised = Math.min(command.value ?? loop.maxContinuations, GOAL_LOOP_MAX_CONTINUATIONS_CEILING)
      this.loops.set(sessionId, { ...loop, maxContinuations: Math.max(loop.maxContinuations, raised), updatedAt: now })
    } else if (command.action === 'resume' && loop.phase === 'paused') {
      this.loops.set(sessionId, { ...loop, phase: 'active', pauseReason: null, updatedAt: now })
      // Resuming an already-idle agent must not wait for a turn_completed
      // that already happened — deliver the next continuation now. If one is
      // still finishing, hand off via pendingContinue instead of dropping.
      const state = this.working.get(sessionId)
      if (!state || !isWorking(state)) {
        if (this.continuing.has(sessionId)) this.pendingContinue.add(sessionId)
        else void this.maybeContinue(sessionId)
      }
    }
    const next = this.loops.get(sessionId)!
    void this.persist()
    return { ...next }
  }

  private now(): Date { return this.deps.now?.() ?? new Date() }

  private signal(sessionId: string, event: unknown): void {
    const loop = this.loops.get(sessionId)
    if (!loop || loop.phase !== 'active') return
    const state = this.working.get(sessionId) ?? INITIAL_WORKING_STATE
    const wasWorking = isWorking(state)
    const next = reduceWorkingState(state, { type: 'semantic', event })
    this.working.set(sessionId, next)
    if (wasWorking && !isWorking(next)) void this.maybeContinue(sessionId)
  }

  private interrupt(sessionId: string): void {
    const loop = this.loops.get(sessionId)
    if (!loop || loop.phase !== 'active') return
    this.loops.set(sessionId, { ...loop, phase: 'paused', pauseReason: 'interrupted', updatedAt: this.now().toISOString() })
    this.working.delete(sessionId)
    void this.persist()
  }

  private async maybeContinue(sessionId: string): Promise<void> {
    const loop = this.loops.get(sessionId)
    if (!loop || loop.phase !== 'active' || this.continuing.has(sessionId)) return
    this.continuing.add(sessionId)
    try {
      // The cap pauses BEFORE delivering past the budget: a confused agent
      // must not get one free continuation beyond what the user armed.
      if (loop.continuationsDelivered >= loop.maxContinuations) {
        this.loops.set(sessionId, { ...loop, phase: 'paused', pauseReason: 'cap', updatedAt: this.now().toISOString() })
        await this.persist()
        return
      }
      const prompt = buildGoalLoopContinuationPrompt({
        goal: loop.goal, loopPrompt: loop.loopPrompt,
        iteration: loop.continuationsDelivered + 1, maxContinuations: loop.maxContinuations,
      })
      let result = await this.deps.manager.deliverPromptToAgent(sessionId, prompt)
      if (!result.ok && result.retrySafe) result = await this.deps.manager.deliverPromptToAgent(sessionId, prompt)
      const current = this.loops.get(sessionId)
      if (!current || current.phase !== 'active') return
      if (result.ok) {
        this.loops.set(sessionId, {
          ...current, continuationsDelivered: current.continuationsDelivered + 1,
          consecutiveDeliveryFailures: 0, updatedAt: this.now().toISOString(),
        })
        // Seed the working state as owed a turn: our prompt STARTS a turn, and
        // if no turn_started/turn_completed pair ever follows (a quiet provider
        // or a missed event), the loop would stall in active with nothing to
        // observe. Seeding here makes the next turn_completed — or a manual
        // resume — able to continue the loop from a truthful state.
        this.working.set(sessionId, { ...INITIAL_WORKING_STATE, phase: 'responding' })
      } else {
        const failures = current.consecutiveDeliveryFailures + 1
        this.loops.set(sessionId, {
          ...current, consecutiveDeliveryFailures: failures,
          ...(failures >= MAX_DELIVERY_FAILURES ? { phase: 'paused' as const, pauseReason: 'error' as const } : {}),
          updatedAt: this.now().toISOString(),
        })
        // WHY self-retry instead of waiting for the next semantic event: a
        // failed delivery usually means no turn will start, so no
        // turn_completed will ever arrive to re-trigger us. Bounded backoff
        // retries keep the loop alive without a hot spin, and MAX rounds
        // still land in paused(error).
        if (failures < MAX_DELIVERY_FAILURES) {
          const retry = setTimeout(() => { void this.maybeContinue(sessionId) }, DELIVERY_RETRY_DELAY_MS)
          retry.unref?.()
        }
      }
      await this.persist()
    } catch (error) {
      console.warn('[goal-loop] continuation failed unexpectedly:', error)
    } finally {
      this.continuing.delete(sessionId)
      if (this.pendingContinue.delete(sessionId)) void this.maybeContinue(sessionId)
    }
  }

  private async persist(): Promise<void> {
    // Bound the file: ended loops are history, newest wins; live loops are
    // never evicted — if they exceed the cap the write fails loudly instead.
    const entries = [...this.loops.entries()]
    const live = entries.filter(([, loop]) => loop.phase !== 'ended')
    const ended = entries.filter(([, loop]) => loop.phase === 'ended')
    const kept = [...live, ...ended.slice(-GOAL_LOOP_STORE_LIMIT)].slice(0, GOAL_LOOP_STORE_LIMIT)
    if (kept.length !== entries.length) {
      this.loops.clear()
      for (const [id, loop] of kept) this.loops.set(id, loop)
    }
    try {
      await this.deps.store.write(this.snapshot())
    } catch (error) {
      console.warn('[goal-loop] persisting loop state failed:', error)
    }
    this.emit('changed')
  }
}
