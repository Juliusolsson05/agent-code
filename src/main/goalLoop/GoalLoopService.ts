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
/**
 * THE RULE THIS FILE IS BUILT ON (#1033, second review): no signal a provider
 * gives us is trustworthy on its own, so hold a continuation only while
 * something POSITIVELY says the agent is working, bound every hold, and when
 * the evidence runs out, deliver.
 *
 * WHY that direction and not "be certain before typing": the certainty is not
 * available. Both reviews killed a gate that claimed it:
 *
 *  - Input readiness is a composer question. Claude derives it from blocking
 *    conditions, composer occupancy and transcript replay; Codex latches it
 *    true for the session once a composer has ever painted. Both read READY in
 *    the middle of a turn — which is exactly why a mid-turn prompt is QUEUED
 *    rather than refused.
 *  - Screen activity (the TUI spinner) is wrong in BOTH directions. Claude
 *    hides the spinner while it streams visible text (upstream REPL.tsx), so a
 *    token gap past the 2.5 s idle debounce publishes `idle` mid-turn; and a
 *    completed tool row that stays in the bottom fifteen lines
 *    (`⏺ 2 agents finished (ctrl+o to expand)`) keeps publishing ACTIVE on an
 *    idle session.
 *
 * So the cost of each mistake decides the design. Typing early costs one
 * QUEUED continuation: Claude accepts it into the queue and runs it when the
 * turn ends — the continuation is early, not lost, and the user sees it in the
 * queue strip. Holding forever costs the whole loop, silently, which is the
 * bug (#1024) this work exists to kill. Early beats stalled, so every hold
 * below has a deadline.
 */
/** How long the SCREEN alone may hold a continuation back once everything else
 * has gone quiet. This is the bound on the latched-tool-label failure: after
 * it, the screen is simply outvoted. */
export const GOAL_LOOP_ACTIVITY_GRACE_MS = 45_000
/** A hold this old is not a long turn — a turn that long has not sent its Stop
 * yet, so nothing is held for it. It means a signal is stuck (a severed stream
 * left `Thinking`, a turn that ended without a Stop). Pause visibly: the strip
 * shows paused · error and Resume re-runs the whole gate. */
export const GOAL_LOOP_HOLD_STALL_MS = 30 * 60_000
/** How often a held continuation re-evaluates itself. A poll, deliberately:
 * every edge-driven version of this lost the continuation when the edge did
 * not arrive (a provider that stops emitting, a turn that ends without a
 * Stop), and a 1 s timer that exists only while something is held is cheaper
 * than the bugs. */
const HOLD_POLL_MS = 1_000

// WHY structural instead of Pick<SessionManager, 'on'>: SessionManager's
// typed event map is not satisfied by a plain EventEmitter test double, and
// the service only needs these four subscriptions plus delivery. The real
// manager satisfies every signature (method bivariance); fakes stay trivial.
type GoalLoopManagerPort = {
  on(event: 'semantic-event', listener: (payload: { sessionId: string; event: unknown }) => void): unknown
  on(event: 'removed', listener: (payload: { sessionId: string }) => void): unknown
  on(event: 'exit', listener: (payload: { sessionId: string }) => void): unknown
  /** The provider's own activity edge. Its quiet side is what releases a held
   *  continuation (#1033) — the same source getProcessStateSnapshot reads, so
   *  a held loop can never disagree with the level it is waiting on. */
  on(event: 'process-state', listener: (payload: { sessionId: string; active: boolean }) => void): unknown
  deliverPromptToAgent: SessionManager['deliverPromptToAgent']
  /** Is the provider visibly working right now? Read at delivery time. */
  getProcessStateSnapshot: SessionManager['getProcessStateSnapshot']
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
  /** Continuations HELD because something said the agent was still working,
   * with the wall-clock instant each one started waiting. A held continuation
   * is never a dropped one: it re-evaluates itself every HOLD_POLL_MS. */
  private readonly heldSince = new Map<string, number>()
  /** The re-evaluation timer for each held session; see holdUntilQuiet. */
  private readonly holdPolls = new Map<string, ReturnType<typeof setTimeout>>()
  /** Hook-driven sessions that have published a semantic event SINCE their
   * last allowed Stop — the ones whose tracked phase is fresh enough to gate
   * a delivery (see phaseIsFresh).
   *
   * WHY a set keyed on arrival order rather than two timestamps compared with
   * `>`: the Stop hook and the events around it land in the same millisecond
   * often enough to matter (it is one local process writing both), and under
   * a test clock they always do. Ordering is what this question is actually
   * about, and a set records it exactly. */
  private readonly eventSinceStop = new Set<string>()

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
    // A quiet edge makes a held continuation land promptly instead of waiting
    // out the poll. It is an OPTIMISATION, never the mechanism: the poll re-
    // reads the level, so a provider that stops emitting edges (or never emits
    // this one) still resolves its hold.
    manager.on('process-state', ({ sessionId, active }: { sessionId: string; active: boolean }) => {
      if (active || !this.heldSince.has(sessionId)) return
      this.requestContinue(sessionId)
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
   * were told it ended. That is why the boundary is not trusted alone: the
   * delivery gate weighs every other signal too and HOLDS the continuation
   * until they all go quiet (#1033, deliveryHold).
   */
  observeProviderHook(sessionId: string, hook: 'user-prompt-submit' | 'post-tool-use' | 'stop', outcome?: { blocked: boolean }): void {
    this.hookSessions.add(sessionId)
    this.lastHookSessionActivity.set(sessionId, Date.now())
    if (hook !== 'stop') {
      this.hookTurnOpen.add(sessionId)
      // New work has started (the same turn continuing past another hook's
      // block, or a prompt the user typed). A continuation held from before it
      // is still wanted — this turn's own end is what will deliver it — but
      // its stall deadline must not keep running across work that is
      // legitimately ongoing, or the loop pauses itself for being patient
      // (second #1033 review). Restart the clock, keep the continuation.
      if (this.heldSince.has(sessionId)) this.heldSince.set(sessionId, Date.now())
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
    this.eventSinceStop.delete(sessionId)
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
    // Nothing may be typed into a finished loop, and a live watchdog would
    // outlive it.
    this.releaseHold(sessionId)
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
    // A loop that is pausing, stopping or being dismissed will not type, so a
    // continuation held for it is void and its poll must not outlive it.
    //
    // WHY RESUME IS NOT IN THAT LIST (second #1033 review): resume used to
    // clear the hold too, on the theory that it re-requests below. It does —
    // but only when the loop was PAUSED. Two resumes in a row (a double-click
    // before the strip repaints) therefore re-armed the loop on the first and
    // threw away its hold and poll on the second, leaving an active loop with
    // no continuation pending and nothing scheduled to look again. Resume now
    // leaves the hold alone and always re-requests, so it can only ever make
    // the loop more likely to deliver.
    // `dismiss` is not in this list because it returned above — an ended loop
    // holds nothing anyway.
    if (command.action === 'pause' || command.action === 'stop') this.releaseHold(sessionId)
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
    }
    // Outside the branch above on purpose: a resume of an ALREADY-active loop
    // (the double-click case) must still push the loop forward rather than do
    // nothing. requestContinue is idempotent — the gate re-runs, and a hold
    // that is still justified simply stays.
    if (command.action === 'resume') this.requestContinue(sessionId)
    const next = this.loops.get(sessionId)!
    void this.persist()
    return { ...next }
  }

  private now(): Date { return this.deps.now?.() ?? new Date() }

  private signal(sessionId: string, event: unknown): void {
    // Any event at all, deltas included, means the provider is still doing
    // something; both the quiet-turn check (Resume) and the settle window
    // (the delivery gate) measure silence from here. Stamped for EVERY
    // session, not only hook-driven ones: the settle window is what covers
    // Claude streaming visible text with its spinner hidden, and that is not
    // a hook-session-only shape.
    this.lastHookSessionActivity.set(sessionId, Date.now())
    this.eventSinceStop.add(sessionId)
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
    // A held continuation belongs to the dead process's turn. Its quiet edge
    // will never come (the last thing a dying session emits is active:false,
    // which must not resurrect a delivery into a process that is gone), and
    // the loop is about to be paused as `interrupted` anyway.
    this.releaseHold(sessionId)
    // A fresh process must prove its hooks again. A reload can change
    // providers or MCP domains, and a turn open in the dead process is gone.
    this.hookSessions.delete(sessionId)
    this.hookTurnOpen.delete(sessionId)
    this.lastHookSessionActivity.delete(sessionId)
    this.eventSinceStop.delete(sessionId)
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
   * What, if anything, says this agent is still working? `null` means the
   * continuation may be typed now.
   *
   * The order is by decreasing trust, and each rule exists because the one
   * above it has a known blind spot:
   *
   *  1. OUR OWN boundary. A hook-driven session's turn is open until its Stop
   *     arrives (observeProviderHook). This is the only signal with no false
   *     "idle" — Claude's subagent flows publish idle mid-turn (#1024), which
   *     is why the phase below is not consulted for these sessions until the
   *     Stop has landed.
   *  2. The semantic phase. After ANOTHER Stop hook blocks ours, the model
   *     keeps going and the proxy publishes `requesting`/`responding` and
   *     pending tools for that continued work. A turn that owes a tool result
   *     is working even when nothing is streaming.
   *  3. The screen, bounded. A live spinner is real evidence of work, and it
   *     is the ONLY signal during the gap between our Stop landing and a
   *     blocked turn's next API request — no event has been published yet, so
   *     (2) is still stale there. But it latches on a completed
   *     `⏺ … (ctrl+o to expand)` row left in the bottom fifteen lines, so it
   *     may only postpone a delivery by GOAL_LOOP_ACTIVITY_GRACE_MS, never
   *     prevent one.
   *
   * THE RESIDUAL, stated because it is a choice and not an oversight: if
   * another hook blocks our Stop while Claude's spinner happens to be down,
   * nothing here knows the turn continued, and the continuation is typed into
   * a live turn — where Claude QUEUES it and runs it when the turn ends. One
   * early continuation, visible in the queue strip. A wait long enough to
   * close that window would have to outlast an arbitrary user hook (a test
   * suite, a build), and every version of this file that tried to be certain
   * instead stalled the loop for good. Early beats stalled.
   *
   * WHY an UNKNOWN session counts as not working: a session main has no
   * process state for is one it is not tracking (a fake in a test, a backend
   * row that lives elsewhere). "I cannot tell" must not hold a loop.
   */
  private deliveryHold(sessionId: string): 'turn-open' | 'phase-working' | 'screen-busy' | null {
    if (this.hookSessions.has(sessionId) && this.hookTurnOpen.has(sessionId)) return 'turn-open'
    const tracked = this.working.get(sessionId)
    if (tracked && this.phaseIsFresh(sessionId) && (isWorking(tracked) || tracked.pendingTools.length > 0)) {
      return 'phase-working'
    }
    const active = this.deps.manager.getProcessStateSnapshot(sessionId)?.active === true
    if (active && this.heldForMs(sessionId) < GOAL_LOOP_ACTIVITY_GRACE_MS) return 'screen-busy'
    return null
  }

  /**
   * May the tracked phase gate a delivery for this session?
   *
   * For a session without hooks, always: its working→idle transition IS the
   * turn boundary, so the same state cannot be too stale to read.
   *
   * For a hook-driven session, only when an event has arrived SINCE the
   * allowed Stop. Two things make that condition load-bearing, in opposite
   * directions:
   *
   *  - Without it, a loop stalls. `markOwedATurn` seeds the state busy when we
   *    deliver, and only a provider event clears it. A hook session that
   *    publishes no semantic stream (or whose stream is late) would sit on
   *    that seed forever and never receive a continuation — the #1028 failure
   *    this file already documents, where phases were rightly distrusted for
   *    hook sessions.
   *  - With it, the phase becomes the thing that catches ANOTHER Stop hook
   *    blocking ours: the model keeps going, its proxy publishes `requesting`
   *    and pending tools, and those events are by construction newer than the
   *    Stop we observed. That is the one case where the phase knows something
   *    the Stop boundary cannot.
   */
  private phaseIsFresh(sessionId: string): boolean {
    return !this.hookSessions.has(sessionId) || this.eventSinceStop.has(sessionId)
  }

  private heldForMs(sessionId: string): number {
    const since = this.heldSince.get(sessionId)
    return since === undefined ? 0 : Date.now() - since
  }

  /**
   * Keep this session's continuation and re-evaluate it until it can be
   * delivered.
   *
   * WHY holding rather than returning: the first #1033 fix skipped the
   * delivery and relied on "the turn's real end re-triggers the loop". For a
   * hook session there is no such re-trigger — the Stop we were answering IS
   * the turn's end, and no further Stop fires while the model works through
   * another hook's continuation. The loop sat `active` with zero deliveries
   * and nothing left to observe.
   *
   * WHY the re-evaluation is a poll and not the provider's quiet edge: the
   * second review reproduced three ways an edge never arrives — a turn that
   * reopens and then ends through Esc or an API error (no Stop), a provider
   * that stops emitting, a detector latched on a stale row. Each one left the
   * continuation held with nothing scheduled to look at it again. A 1 s timer
   * that exists only while something is held cannot have that failure mode.
   */
  private holdUntilQuiet(sessionId: string, reason: string): void {
    if (!this.heldSince.has(sessionId)) this.heldSince.set(sessionId, Date.now())
    if (this.heldForMs(sessionId) >= GOAL_LOOP_HOLD_STALL_MS) {
      this.pauseStalledHold(sessionId, reason)
      return
    }
    if (this.holdPolls.has(sessionId)) return
    const timer = setTimeout(() => {
      this.holdPolls.delete(sessionId)
      // The loop may have been paused, stopped or completed while we waited;
      // releasing here is what stops the poll from outliving it.
      if (this.loops.get(sessionId)?.phase !== 'active') {
        this.releaseHold(sessionId)
        return
      }
      this.requestContinue(sessionId)
    }, HOLD_POLL_MS)
    timer.unref?.()
    this.holdPolls.set(sessionId, timer)
  }

  private releaseHold(sessionId: string): void {
    this.heldSince.delete(sessionId)
    const timer = this.holdPolls.get(sessionId)
    if (timer) clearTimeout(timer)
    this.holdPolls.delete(sessionId)
  }

  /** Something has claimed this agent is working for half an hour after its
   * turn ended. That is a stuck signal, not a long turn, so pause VISIBLY
   * (paused · error, with Resume) rather than leaving a loop that looks armed
   * and will never prompt again. */
  private pauseStalledHold(sessionId: string, reason: string): void {
    this.releaseHold(sessionId)
    const loop = this.loops.get(sessionId)
    if (!loop || loop.phase !== 'active') return
    console.warn(`[goal-loop] ${sessionId}: held for ${Math.round(GOAL_LOOP_HOLD_STALL_MS / 60_000)} min on "${reason}" after its turn ended; pausing instead of typing into it`)
    this.loops.set(sessionId, { ...loop, phase: 'paused', pauseReason: 'error', updatedAt: this.now().toISOString() })
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
      // The one gate every trigger passes through, evaluated as late as
      // possible so it reads the freshest state (#1033). A turn-boundary
      // trigger is idle by construction, but a backoff retry, a parked
      // pendingContinue or a hold poll is evaluated LATER — after a user-typed
      // turn began, or after the delivery it raced succeeded. A held
      // continuation is kept and re-evaluated, never dropped.
      const hold = this.deliveryHold(sessionId)
      if (hold) {
        this.holdUntilQuiet(sessionId, hold)
        return
      }
      this.releaseHold(sessionId)
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
