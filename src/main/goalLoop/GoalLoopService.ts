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
/** How long a hook-driven turn must have been silent (no hook, no semantic
 * event) before Resume may treat it as over without a Stop. See control(). */
export const GOAL_LOOP_QUIET_TURN_MS = 60_000

// WHY structural instead of Pick<SessionManager, 'on'>: SessionManager's
// typed event map is not satisfied by a plain EventEmitter test double, and
// the service only needs these three subscriptions plus delivery. The real
// manager satisfies every signature (method bivariance); fakes stay trivial.
type GoalLoopManagerPort = {
  on(event: 'semantic-event', listener: (payload: { sessionId: string; event: unknown }) => void): unknown
  on(event: 'removed', listener: (payload: { sessionId: string }) => void): unknown
  on(event: 'exit', listener: (payload: { sessionId: string }) => void): unknown
  deliverPromptToAgent: SessionManager['deliverPromptToAgent']
  /** The provider's own readiness, read at delivery time (#1033). */
  getBackendSnapshot: SessionManager['getBackendSnapshot']
}

/** The harness-owned goal loop (#1001).
 *
 * WHY the loop lives in main and does not BLOCK a provider Stop hook: Claude
 * Code force-stops after 9 consecutive Stop-hook blocks, so hook-driven
 * persistence modes die young (oh-my-claudecode #3138), and OpenCode has no
 * block-capable Stop hook at all. We own deliverPromptToAgent and deliver
 * each continuation as a fresh prompt, so the loop is provider-agnostic and
 * unbounded by provider overrides.
 *
 * WHERE the turn boundary comes from (#1024): Claude and Codex sessions that
 * call Agent Code's turn hooks end a turn on their allowed Stop hook, OBSERVED
 * here (observeProviderHook), never blocked. Every other session (OpenCode,
 * Grok) ends a turn on a semantic working→idle transition. The phase signal
 * is not trusted for hook sessions: a Claude subagent's flow publishes idle
 * in the middle of a turn.
 *
 * WHY attention/conditions are NOT subscribed: a permission prompt parks the
 * agent on the USER's decision; delivering a continuation behind that dialog
 * would queue a prompt the user never saw. The pending tool behind that
 * prompt holds both boundaries back.
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
  /** One deferred turn-boundary check per session; see scheduleContinueCheck. */
  private readonly continueCheckTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** A continuation requested while another was still finishing (resume
   * racing the tail of a cap-pause write, a backoff retry racing a slow
   * persist, a turn that settled during the post-delivery write). The
   * in-flight run picks it up in its finally block, so neither a control
   * action nor a turn boundary can be silently dropped. */
  private readonly pendingContinue = new Set<string>()
  /** Sessions whose provider has proven it calls turn hooks (#1024). For
   * these, the provider's own Stop hook is the ONLY turn boundary; see
   * observeProviderHook. */
  private readonly hookSessions = new Set<string>()
  /** Hook-driven sessions whose current turn has started and not yet had an
   * allowed Stop. Replaces the phase-derived working state for those
   * sessions: that state cannot tell a tool gap from a turn end. */
  private readonly hookTurnOpen = new Set<string>()
  /** Last hook, semantic event or delivery per hook-driven session, in ms.
   * Only Resume reads it; see control(). */
  private readonly lastHookSessionActivity = new Map<string, number>()

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

  /**
   * A provider turn hook fired for this session. Agent Code receives Claude
   * and Codex hooks at /hooks/tldr/*, and BuiltInMcpHttpHost forwards every
   * one here.
   *
   * WHY a hook and not the stream phase (#1024): for Claude, phase `idle`
   * means "no main API request is streaming", and inside one turn that is
   * true at every local tool gap. A Task subagent's API flow can take phase
   * ownership during such a gap, publish `requesting`, then be demoted with
   * `idle` as `cc_is_subagent`. That edge is never retracted. One recorded
   * session delivered 37 continuations mid-turn that way, including pairs
   * 0.4 s apart. The Stop hook fires only when the MAIN agent ends its turn
   * (subagents have SubagentStop), so it is the boundary a loop needs.
   *
   * The first hook of any kind proves the session's hooks work.
   * goal_loop_start is a tool call, so PostToolUse always arrives before the
   * turn that started the loop can end. From then on stream phases no longer
   * trigger continuations for this session. A provider that never calls hooks
   * (OpenCode, Grok) never enters this mode and keeps the phase fallback.
   *
   * `blocked`: a Stop that TLDR enforcement answered with `decision: block`
   * does not end the turn. The model keeps going, so it is not a boundary.
   *
   * "Allowed" means only that OUR hook allowed it. Claude runs every Stop
   * hook in parallel and keeps the turn going if ANY of them blocks, and
   * Codex aggregates the same way, so a user, project or plugin hook that
   * blocks ("run the tests before stopping") leaves the turn running after we
   * were told it ended. That is why the boundary is not trusted alone:
   * `providerAcceptsInput` re-asks the provider itself immediately before
   * typing (#1033).
   */
  observeProviderHook(sessionId: string, hook: 'user-prompt-submit' | 'post-tool-use' | 'stop', outcome?: { blocked: boolean }): void {
    this.hookSessions.add(sessionId)
    this.lastHookSessionActivity.set(sessionId, Date.now())
    if (hook !== 'stop') {
      this.hookTurnOpen.add(sessionId)
      // A typed prompt STARTS a turn, and UserPromptSubmit publishes no
      // semantic event, so the tracked phase would still read the previous
      // turn's idle. Seed it busy, exactly as markOwedATurn does for our own
      // delivery: only a real event can make it idle again. Otherwise a
      // Resume during that turn's silent first request (a 529 retry backoff,
      // a long time-to-first-token) found idle + nothing pending + 60 s of
      // silence and delivered into the live turn (#1028 re-review, probe G).
      if (hook === 'user-prompt-submit') this.seedBusy(sessionId)
      return
    }
    if (outcome?.blocked) return
    this.hookTurnOpen.delete(sessionId)
    if (this.loops.get(sessionId)?.phase !== 'active') return
    // Deferred one macrotask so the Stop hook's HTTP answer reaches the
    // provider first. Delivering inside the hook request would race the
    // provider's own turn close.
    const timer = setTimeout(() => this.requestContinue(sessionId), 0)
    timer.unref?.()
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
      // A hook-driven turn can end with NO Stop hook (#1028 review). Claude
      // skips Stop on an Esc interrupt, a model or API error (it runs
      // StopFailure, which Agent Code does not register, see below), and
      // prompt-too-long. Codex skips it on interrupt and on turn errors. The
      // turn then stays open here until the next turn boundary. Any user
      // prompt is one (UserPromptSubmit, then that turn's Stop). Resume is
      // the other, but ONLY when the phase has gone idle.
      //
      // KNOWN LIMIT (#1040): after an Esc during a Claude stream the phase
      // never goes idle. mitmproxy reports a client disconnect only through
      // its `error` hook, which the proxy addon does not implement, so no
      // response-end reaches the adapter. For that case only a typed prompt
      // recovers the loop, and Resume delivers nothing. That is safe but
      // unhelpful, and the fix belongs in claude-code-headless.
      //
      // Resume closes such a turn only when every signal agrees it is over:
      // - no tool pending;
      // - the phase state idle;
      // - nothing heard for GOAL_LOOP_QUIET_TURN_MS.
      // Each one alone is wrong somewhere. Phase idle happens mid-turn on
      // Claude's subagent flows (#1024). Silence happens mid-turn during
      // Codex reasoning that streams no summary and during Claude's API retry
      // backoff; there the phase is thinking or requesting. A pending tool
      // can run for minutes (a build, a test suite). A Resume that finds the
      // turn still open delivers nothing, and the turn's own Stop continues
      // the loop.
      //
      // WHY there is no automatic "quiet turn" pause: the first review fix
      // paused the loop after 60 s of silence. The re-review showed that it
      // paused turns that were still working, and unattended loops then
      // stopped for good. A turn that ended without a Stop costs one user
      // prompt; a false pause costs the whole loop.
      //
      // WHY Claude's StopFailure is not registered as a turn end: the hook
      // JSON shares one --settings argument with the external-control
      // exclusion, and Claude validates hook keys against a fixed enum. A CLI
      // older than the event would reject that argument, exclusion included,
      // and nothing gates on the CLI version.
      const tracked = this.working.get(sessionId)
      if (
        this.hookTurnOpen.has(sessionId)
        && this.quietForMs(sessionId) >= GOAL_LOOP_QUIET_TURN_MS
        && (!tracked || (!isWorking(tracked) && tracked.pendingTools.length === 0))
      ) {
        this.hookTurnOpen.delete(sessionId)
      }
      // Resuming an already-idle agent must not wait for a turn end that
      // already happened, so deliver the next continuation now. A working
      // agent is left alone and its turn end is the trigger. For a session
      // without hooks, "working" is the tracked phase state, which signal()
      // keeps updating while the loop is paused. For a hook session it is an
      // open turn.
      this.requestContinue(sessionId)
    }
    const next = this.loops.get(sessionId)!
    void this.persist()
    return { ...next }
  }

  private now(): Date { return this.deps.now?.() ?? new Date() }

  private signal(sessionId: string, event: unknown): void {
    // Any event at all, deltas included, means the provider is still doing
    // something; the quiet-turn check measures silence from here.
    if (this.hookSessions.has(sessionId)) this.lastHookSessionActivity.set(sessionId, Date.now())
    // Reduce for every session, in every loop phase (see the class comment):
    // only the DECISION to continue is gated on an active loop. The reducer
    // returns the same object for the high-volume delta events, so the common
    // case is one map read and an identity check.
    const state = this.working.get(sessionId) ?? INITIAL_WORKING_STATE
    const next = reduceWorkingState(state, { type: 'semantic', event })
    if (next === state) return
    this.working.set(sessionId, next)
    // Hook-driven sessions take their turn boundary from the provider's Stop
    // hook only (observeProviderHook). Their phase edges are exactly the
    // false positives #1024 recorded, so they never schedule a continuation.
    if (this.hookSessions.has(sessionId)) return
    if (isWorking(state) && !isWorking(next) && this.loops.get(sessionId)?.phase === 'active') {
      this.scheduleContinueCheck(sessionId)
    }
  }

  /** WHY the turn-boundary decision is deferred to a macrotask: a provider
   * event batch can contain a transient working→idle blip that the very next
   * event in the SAME batch retracts — Claude's adapter clears a mis-promoted
   * 'requesting' sidecar phase by publishing a brief 'idle' mid-turn
   * (ClaudeProxyAdapter.ts, "Publish phase: 'idle' to clear the brief
   * requesting"). Deciding synchronously delivered a continuation into a live
   * turn. After the batch settles, the re-checks below see the retraction.
   * Resume and backoff paths do NOT go through here: they already evaluate a
   * settled state. */
  private scheduleContinueCheck(sessionId: string): void {
    if (this.continueCheckTimers.has(sessionId)) return
    const timer = setTimeout(() => {
      this.continueCheckTimers.delete(sessionId)
      const tracked = this.working.get(sessionId)
      // Same two safety lines as maybeContinue's entry check, evaluated AFTER
      // the batch: an agent back to work, or one whose turn still owes a tool
      // result (the fold's hasPendingSemanticTools semantics), is not idle —
      // skipping is safe because the real turn end re-triggers this path.
      if (tracked && (isWorking(tracked) || tracked.pendingTools.length > 0)) return
      this.requestContinue(sessionId)
    }, 0)
    timer.unref?.()
    this.continueCheckTimers.set(sessionId, timer)
  }

  private interrupt(sessionId: string): void {
    // Dropped unconditionally: a same-id wake starts a fresh process whose
    // events must not be folded onto the dead one's pending tools.
    this.working.delete(sessionId)
    // A fresh process must prove its hooks again. A reload can change
    // providers or MCP domains, and a turn open in the dead process is gone.
    this.hookSessions.delete(sessionId)
    this.hookTurnOpen.delete(sessionId)
    this.lastHookSessionActivity.delete(sessionId)
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
    // Our delivery starts a turn. For a hook-driven session that turn is
    // open until its Stop, so traffic in between can never re-deliver. That
    // is the recorded 0.4 s double.
    // No activity stamp is needed here for Resume's quiet window: the seed
    // below leaves the tracked phase busy, and only an event (which stamps)
    // can make it idle again.
    if (this.hookSessions.has(sessionId)) this.hookTurnOpen.add(sessionId)
    this.seedBusy(sessionId)
  }

  private seedBusy(sessionId: string): void {
    const tracked = this.working.get(sessionId) ?? INITIAL_WORKING_STATE
    if (!isWorking(tracked)) this.working.set(sessionId, { ...tracked, phase: 'responding' })
  }

  /** Wall-clock silence, not the injected `now()`: that clock stamps loop
   * records and tests pin it to a fixed instant, which would make every turn
   * look silent forever. */
  private quietForMs(sessionId: string): number {
    return Date.now() - (this.lastHookSessionActivity.get(sessionId) ?? 0)
  }

  /** Every trigger (turn boundary, resume, backoff retry) funnels through
   * here so none of them can be lost to the re-entrancy guard. */
  private requestContinue(sessionId: string): void {
    if (this.continuing.has(sessionId)) this.pendingContinue.add(sessionId)
    else void this.maybeContinue(sessionId)
  }

  /**
   * Is the provider ready to accept typed input right now?
   *
   * WHY an UNKNOWN session answers yes: a session main has no snapshot for is
   * one it is not tracking (a terminal-runtime pane whose backend row lives
   * elsewhere, a fake in a test). Treating "I cannot tell" as "do not
   * deliver" would silently stop those loops forever, which is a worse
   * failure than the one this guards. `deliverPromptToAgent` still refuses a
   * genuinely unready target, retry-safely.
   */
  private providerAcceptsInput(sessionId: string): boolean {
    const snapshot = this.deps.manager.getBackendSnapshot(sessionId)
    if (!snapshot) return true
    return snapshot.input.ready
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
    // Hook-driven sessions: an open turn (started, no allowed Stop yet) is
    // the truth, and the phase-derived state is not consulted. It reads
    // `requesting` whenever a subagent flow streams, which would stall a loop
    // whose Stop just arrived.
    if (this.hookSessions.has(sessionId)) {
      if (this.hookTurnOpen.has(sessionId)) return
    } else if (tracked && isWorking(tracked)) return
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
      // The last gate, and the only one that asks the PROVIDER rather than our
      // own bookkeeping (#1033). Our Stop hook allowing a turn to end does not
      // mean the turn ended: another configured hook can block, and both CLIs
      // keep going when any hook does. Input readiness is the provider's own
      // answer to "can something be typed right now", and it is the same
      // signal the composer gate uses, so a continuation can no longer land
      // mid-turn as a queued command — the #1024 symptom.
      if (!this.providerAcceptsInput(sessionId)) return
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
