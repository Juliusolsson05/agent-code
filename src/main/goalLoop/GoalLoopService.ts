import { EventEmitter } from 'node:events'
import type { SessionManager } from '@main/sessionManager.js'
import { buildGoalLoopContinuationPrompt } from '@mcp/shared/goalLoopPrompt.js'
import { INITIAL_WORKING_STATE, isWorking, reduceWorkingState } from '@shared/agentActivity/workingState.js'
import type { WorkingState } from '@shared/agentActivity/workingState.js'
import type { GoalLoopControlAction, GoalLoopState } from '@shared/types/goalLoop.js'
import { GOAL_LOOP_DEFAULT_MAX_CONTINUATIONS, GOAL_LOOP_MAX_CONTINUATIONS_CEILING } from '@shared/types/goalLoop.js'
import { GOAL_LOOP_STORE_LIMIT, GoalLoopStore } from './GoalLoopStore.js'

const MAX_DELIVERY_FAILURES = 3
const DELIVERY_RETRY_DELAY_MS = 250

// WHY structural instead of Pick<SessionManager, 'on'>: SessionManager's
// typed event map is not satisfied by a plain EventEmitter test double, and
// the service only needs these three subscriptions plus delivery. The real
// manager satisfies every signature (method bivariance); fakes stay trivial.
type GoalLoopManagerPort = {
  on(event: 'semantic-event', listener: (payload: { sessionId: string; event: unknown }) => void): unknown
  on(event: 'removed', listener: (payload: { sessionId: string }) => void): unknown
  on(event: 'exit', listener: (payload: { sessionId: string }) => void): unknown
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
 * WHY the working state is tracked for EVERY session, loop or not (review of
 * #1003): the first version reduced events only while a loop was active and
 * seeded a blank `responding` state at goal_loop_start. Two things broke:
 *
 *  1. Claude publishes `turn_completed` per assistant MESSAGE (at
 *     message_delta, ClaudeProxyAdapter), including the tool_use message that
 *     carries goal_loop_start itself, and those events reach main through a
 *     200 ms proxy poll while the MCP call arrives within milliseconds. So the
 *     tool's `block_started` was usually seen BEFORE the loop existed (and
 *     dropped) while its `turn_completed` landed AFTER the blank seed — which,
 *     having no pending tool to hold it, went idle and delivered continuation
 *     #1 into the middle of the turn that had just started the loop. Tracking
 *     from the first event means the reducer already holds that tool as
 *     pending, which is exactly the guard workingState.ts documents.
 *  2. A loop paused mid-turn never saw that turn end, so its state stayed
 *     `responding` forever and Resume — which rightly refuses to prompt a
 *     working agent — left the loop `active` with nothing left to observe.
 *
 * The cost is one cheap reducer call per semantic event, the same price
 * AgentActivityRecorder already pays, and the map is bounded by live sessions
 * (dropped on `removed`/`exit`).
 *
 * Re-entrancy: one continuation per session at a time (`continuing`). A
 * trigger that arrives while one is finishing is parked in `pendingContinue`
 * and re-evaluated in the finally block rather than dropped, and EVERY path
 * re-checks the tracked state before delivering, so a parked trigger that is
 * stale by then (the delivery it raced succeeded and seeded `responding`) is
 * a no-op instead of a second prompt. deliverPromptToAgent's own in-flight
 * mutual exclusion inside SessionManager is the last gate.
 *
 * Known v1 gap versus the spec: parked agents are NOT woken through the
 * `ensure-agent-live` round-trip. That request is parent-scoped orchestration
 * plumbing (it authorizes by parentSessionId) and a loop has no parent. A
 * parked session fails delivery as retry-safe `not-ready`, so the loop lands
 * in paused(error) — visible and resumable — rather than prompting a dead
 * process.
 */
export class GoalLoopService extends EventEmitter {
  private readonly loops = new Map<string, GoalLoopState>()
  private readonly working = new Map<string, WorkingState>()
  private readonly continuing = new Set<string>()
  /** A continuation requested while another was still finishing (resume
   * racing the tail of a cap-pause write, a backoff retry racing a slow
   * persist, a turn that settled during the post-delivery write). The
   * in-flight run picks it up in its finally block, so neither a control
   * action nor a turn boundary can be silently dropped. */
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
    this.markOwedATurn(sessionId)
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

  control(sessionId: string, command: { action: GoalLoopControlAction; value?: number }): GoalLoopState | null {
    const loop = this.loops.get(sessionId)
    if (!loop) return null
    const now = this.now().toISOString()
    if (command.action === 'dismiss') {
      // WHY dismiss exists: the pane strip is always-on while a loop EXISTS
      // for the session, and an ended loop exists until 200 newer ones evict
      // it. Without this, every finished loop left an undismissable strip
      // over the top line of its pane — across restarts, since ended loops
      // are persisted. Only ended loops can be dismissed: a live loop must
      // stay visible for as long as it can still prompt the agent.
      if (loop.phase !== 'ended') return { ...loop }
      this.loops.delete(sessionId)
      void this.persist()
      return null
    }
    if (command.action === 'pause' && loop.phase === 'active') {
      this.loops.set(sessionId, { ...loop, phase: 'paused', pauseReason: 'user', updatedAt: now })
    } else if (command.action === 'stop' && loop.phase !== 'ended') {
      this.loops.set(sessionId, { ...loop, phase: 'ended', endReason: 'cancelled', pauseReason: null, updatedAt: now })
    } else if (command.action === 'raise-cap') {
      const raised = Math.min(command.value ?? loop.maxContinuations, GOAL_LOOP_MAX_CONTINUATIONS_CEILING)
      this.loops.set(sessionId, { ...loop, maxContinuations: Math.max(loop.maxContinuations, raised), updatedAt: now })
    } else if (command.action === 'resume' && loop.phase === 'paused') {
      // A resume is the user vouching for the session again, so it gets a
      // fresh failure budget; otherwise a loop resumed from paused(error)
      // would re-pause on its first hiccup with no backoff at all.
      this.loops.set(sessionId, { ...loop, phase: 'active', pauseReason: null, consecutiveDeliveryFailures: 0, updatedAt: now })
      // Resuming an already-idle agent must not wait for a turn_completed
      // that already happened — deliver the next continuation now. A working
      // agent is left alone: its turn end is the trigger, and that state is
      // truthful because signal() keeps tracking while the loop is paused.
      this.requestContinue(sessionId)
    }
    const next = this.loops.get(sessionId)!
    void this.persist()
    return { ...next }
  }

  private now(): Date { return this.deps.now?.() ?? new Date() }

  private signal(sessionId: string, event: unknown): void {
    // Reduce for every session, in every loop phase (see the class comment):
    // only the DECISION to continue is gated on an active loop. The reducer
    // returns the same object for the high-volume delta events, so the common
    // case is one map read and an identity check.
    const state = this.working.get(sessionId) ?? INITIAL_WORKING_STATE
    const next = reduceWorkingState(state, { type: 'semantic', event })
    if (next === state) return
    this.working.set(sessionId, next)
    if (isWorking(state) && !isWorking(next) && this.loops.get(sessionId)?.phase === 'active') {
      this.requestContinue(sessionId)
    }
  }

  private interrupt(sessionId: string): void {
    // Dropped unconditionally: a same-id wake starts a fresh process whose
    // events must not be folded onto the dead one's pending tools.
    this.working.delete(sessionId)
    const loop = this.loops.get(sessionId)
    if (!loop || loop.phase !== 'active') return
    this.loops.set(sessionId, { ...loop, phase: 'paused', pauseReason: 'interrupted', updatedAt: this.now().toISOString() })
    void this.persist()
  }

  /** The agent is about to run (or is running) a turn the loop must see the
   * end of. goal_loop_start is a tool call INSIDE a turn and our own delivery
   * STARTS one, but the events that say so may not have arrived yet (200 ms
   * proxy poll) or may never arrive (a provider that publishes turn_completed
   * without turn_started or phases). Without this, that turn's end would not
   * be a working→idle transition and the loop would stall with nothing to
   * observe.
   *
   * WHY it only fills in a non-working state, and keeps the rest of it: when
   * events DID arrive, the tracked state is the truth — in particular its
   * pending tools are what hold a per-message `turn_completed` back. The
   * first version overwrote it with a blank state and lost exactly that. */
  private markOwedATurn(sessionId: string): void {
    const tracked = this.working.get(sessionId) ?? INITIAL_WORKING_STATE
    if (!isWorking(tracked)) this.working.set(sessionId, { ...tracked, phase: 'responding' })
  }

  /** Every trigger (turn boundary, resume, backoff retry) funnels through
   * here so none of them can be lost to the re-entrancy guard. */
  private requestContinue(sessionId: string): void {
    if (this.continuing.has(sessionId)) this.pendingContinue.add(sessionId)
    else void this.maybeContinue(sessionId)
  }

  private async maybeContinue(sessionId: string): Promise<void> {
    const loop = this.loops.get(sessionId)
    if (!loop || loop.phase !== 'active' || this.continuing.has(sessionId)) return
    // The one rule every trigger shares: never prompt an agent that is
    // working. A turn-boundary trigger arrives idle by construction, but a
    // backoff retry or a parked pendingContinue is evaluated LATER — after a
    // user-typed turn began, or after the delivery it raced succeeded and
    // marked the session owed a turn. Without this check, pause→resume during
    // an in-flight delivery delivered the same continuation twice. Skipping is
    // safe: a working agent's turn end re-triggers us.
    const tracked = this.working.get(sessionId)
    if (tracked && isWorking(tracked)) return
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
        // Our prompt STARTS a turn; make sure its end is observable even when
        // the turn's own events are late or absent (see markOwedATurn). This
        // is also what turns a stale parked trigger into a no-op.
        this.markOwedATurn(sessionId)
      } else {
        const failures = current.consecutiveDeliveryFailures + 1
        // WHY a non-retry-safe failure pauses at once instead of backing off:
        // `retrySafe: false` means prompt bytes or Enter already reached the
        // PTY (an acceptance timeout after Enter, a provider that threw
        // mid-write), so the continuation may well be running. The first
        // version honoured retrySafe for the immediate retry above but not
        // for the backoff below, and re-sent the same prompt 250 ms later —
        // the duplicate-queue-entry failure PromptDeliveryResult was made
        // richer to prevent. An unknown outcome is the user's call: the strip
        // shows paused · error, and Resume is safe because it re-checks the
        // tracked state, which by then reflects whether a turn really began.
        const pause = !result.retrySafe || failures >= MAX_DELIVERY_FAILURES
        this.loops.set(sessionId, {
          ...current, consecutiveDeliveryFailures: failures,
          ...(pause ? { phase: 'paused' as const, pauseReason: 'error' as const } : {}),
          updatedAt: this.now().toISOString(),
        })
        // WHY self-retry instead of waiting for the next semantic event: a
        // cleanly rejected delivery means no turn will start, so no
        // turn_completed will ever arrive to re-trigger us. Bounded backoff
        // retries keep the loop alive without a hot spin, and MAX rounds
        // still land in paused(error). Through requestContinue, not
        // maybeContinue: this run still holds `continuing` until its persist
        // below settles, and on a slow disk a direct call would hit that
        // guard and drop the only trigger this loop has left.
        if (!pause) {
          const retry = setTimeout(() => this.requestContinue(sessionId), DELIVERY_RETRY_DELAY_MS)
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
    // Bound the map (and so the file, whose reader rejects more than
    // GOAL_LOOP_STORE_LIMIT entries). Eviction order, least valuable first:
    // oldest ended, then oldest paused. ACTIVE loops are never evicted — each
    // needs a live agent process, which bounds them far below the limit.
    //
    // WHY paused loops are evictable at all: every removed session and every
    // app restart turns an active loop into paused(interrupted), and most of
    // those sessions never come back, so "never evict a live loop" grew
    // without bound. The first version also did not do what its comment said:
    // a trailing `.slice(0, LIMIT)` over [live…, ended…] silently dropped the
    // NEWEST entries once the map was full — the newest ended loops first,
    // and past 200 live loops the loop that had just been started.
    const entries = [...this.loops.entries()]
    if (entries.length > GOAL_LOOP_STORE_LIMIT) {
      const newestFirst = (a: [string, GoalLoopState], b: [string, GoalLoopState]) =>
        Date.parse(b[1].updatedAt) - Date.parse(a[1].updatedAt)
      const inPhase = (phase: GoalLoopState['phase']) => entries.filter(([, loop]) => loop.phase === phase)
      const active = inPhase('active')
      const evictable = [...inPhase('paused').sort(newestFirst), ...inPhase('ended').sort(newestFirst)]
      const kept = [...active, ...evictable.slice(0, Math.max(0, GOAL_LOOP_STORE_LIMIT - active.length))]
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
