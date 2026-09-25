import { EventEmitter } from 'node:events'
import type { SessionManager } from '@main/sessionManager.js'
import { buildGoalLoopContinuationPrompt } from '@mcp/shared/goalLoopPrompt.js'
import { INITIAL_WORKING_STATE, isWorking, reduceWorkingState } from '@shared/agentActivity/workingState.js'
import type { WorkingState } from '@shared/agentActivity/workingState.js'
import type { GoalLoopControlAction, GoalLoopState } from '@shared/types/goalLoop.js'
import { GOAL_LOOP_DEFAULT_MAX_CONTINUATIONS, GOAL_LOOP_MAX_CONTINUATIONS_CEILING } from '@shared/types/goalLoop.js'
import { GOAL_LOOP_STORE_LIMIT, GoalLoopStore } from './GoalLoopStore.js'

/**
 * Is this event evidence that the AGENT is doing work, as opposed to the
 * proxy talking about itself?
 *
 * Only the flow-selection machinery is excluded: `flow_selected` and
 * `flow_ignored` name which upstream /v1/messages call is being rendered
 * from — title generation, a retry, a subagent's stream — so they are
 * published about work this agent is not doing.
 *
 * PHASES COUNT, after a round of getting this wrong in both directions
 * (#1033 rounds 6 and 7). Excluding them caught Claude's sidecar churn
 * (`flow_selected → requesting → idle → flow_ignored`, #1024's recorded
 * sequence) — and also threw away the only progress signal Grok and managed
 * OpenCode Terminal publish during a turn, which paused a working loop after
 * thirty minutes. No classification of an event type can separate those two,
 * because they are the same type. What separates them is TIME, which is why
 * the hold has an absolute deadline as well as a silence one.
 */
function isAgentProgress(event: unknown): boolean {
  const type = (event as { type?: unknown } | null)?.type
  if (typeof type !== 'string') return false
  return type !== 'flow_selected' && type !== 'flow_ignored'
}

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
/** A hold that has seen NOTHING for this long is waiting on a stuck signal (a
 * severed stream left `Thinking`, a turn that ended without a Stop). Pause
 * visibly: the strip shows paused · error and Resume re-runs the whole gate.
 * A dispatched tool with a live process behind it is exempt — that is a build
 * or a test suite, not a stuck signal — which is what the absolute limit
 * below exists to bound. */
export const GOAL_LOOP_HOLD_STALL_MS = 30 * 60_000
/**
 * The outside edge of any hold, exempt from nothing.
 *
 * WHY a second deadline (#1033 round 7): the silence deadline can be renewed
 * by traffic, and the tool exemption suspends it entirely, so between them a
 * loop could wait forever — a six-hour silent tool, or a session whose proxy
 * publishes flow bookkeeping every minute. Perfect classification of "is this
 * event real work" is not available (the same event type means work on one
 * provider and bookkeeping on another), so the guarantee is made with time
 * instead: whatever is happening, a held continuation either lands or the
 * loop pauses where the user can see it.
 *
 * Two hours: longer than any real tool run recorded in this project, and
 * short enough that an unattended loop does not sit dead overnight.
 */
export const GOAL_LOOP_HOLD_LIMIT_MS = 2 * 60 * 60_000
/** How often a held continuation re-evaluates itself. A poll, deliberately:
 * every edge-driven version of this lost the continuation when the edge did
 * not arrive (a provider that stops emitting, a turn that ends without a
 * Stop), and a 1 s timer that exists only while something is held is cheaper
 * than the bugs. */
const HOLD_POLL_MS = 1_000
/**
 * How long ONE Stop's report of background work may hold a continuation.
 *
 * WHY background work gets its own bound, and why it DELIVERS rather than
 * pauses when it runs out (#1224 review, both reviewers, against the 2.1.282
 * binary): the CLI cannot tell us whether a background task will ever end.
 * The Monitor tool registers as a `local_bash` task and goes out on the wire
 * as `type: "shell"` with no `kind`, so a persistent monitor is
 * indistinguishable from a build running in the background, and a dev server
 * started with `run_in_background` never ends either (36 corpus tasks ran past
 * two hours). Under the absolute limit alone, such a shell parked an
 * unattended loop for two hours, paused it as an error, and after each Resume
 * the next turn's Stop listed the same shell and parked it again.
 *
 * Expiring the report instead restores exactly the pre-#1138 behaviour for
 * work that outlives it: the continuation lands, at worst the agent answers
 * "still waiting" once, and that turn's Stop starts a fresh window if the work
 * is still listed. A never-ending shell therefore costs one continuation per
 * window, never a dead loop.
 *
 * Forty-five minutes: past the 20–40 minute background implementers #1138
 * was about, so the common case still waits for its notification, and inside
 * the hour so a loop beside a dev server keeps moving.
 */
export const GOAL_LOOP_BACKGROUND_WORK_LIMIT_MS = 45 * 60_000

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
/** One entry of Claude Code's Stop-hook `background_tasks` (2.1.280+). Only
 *  the two fields the loop reads; the CLI sends more (id, description, …). */
export type GoalLoopBackgroundTask = { type: string; status: string }

/**
 * Will this background task wake the agent by itself when it finishes?
 *
 * Shells, subagents, workflows and MCP tasks end with a task-notification
 * that starts a new turn, so the agent is waiting on them. The wire names are
 * the CLI's own map (2.1.282: local_bash→"shell", local_agent→"subagent",
 * local_workflow→"workflow", mcp_task→"MCP task"). `monitor` is what
 * monitor_mcp/monitor_ws tasks are called, and those never finish, so they are
 * not held on. The Monitor TOOL is different: it is a local_bash task and
 * arrives as "shell", so it IS held on. That hold is bounded by
 * GOAL_LOOP_BACKGROUND_WORK_LIMIT_MS, which is what keeps a persistent monitor
 * from parking the loop. Ruling: unknown types are NOT held on, so a new CLI
 * task kind cannot silently stall loops. Only running/pending entries count
 * (the CLI only emits those: its filter is running || pending).
 */
function wakesTheAgent(task: GoalLoopBackgroundTask): boolean {
  if (task.status !== 'running' && task.status !== 'pending') return false
  return task.type === 'shell' || task.type === 'subagent' || task.type === 'workflow' || task.type === 'MCP task'
}

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
  /** When each held continuation STARTED waiting. Never moves while the hold
   * lasts, which is what makes the screen grace a real bound: the screen is
   * the signal that latches on a stale row, so the time it may hold a
   * delivery cannot be renewable by unrelated traffic (#1033 round 4 renewed
   * it indefinitely with turn_started/turn_completed churn). */
  private readonly heldSince = new Map<string, number>()
  /** When each held continuation last saw PROGRESS — the hold's start, then
   * any provider event or hook after it. The stall pause measures from here,
   * so it bounds how long we wait on a SILENT signal and never how long an
   * agent may keep working. */
  private readonly progressSince = new Map<string, number>()
  /** The re-evaluation timer for each held session; see holdUntilQuiet. */
  private readonly holdPolls = new Map<string, ReturnType<typeof setTimeout>>()
  /** Sessions whose last continuation was QUEUED by the provider rather than
   * started as a turn, and has not been seen to start yet.
   *
   * WHY it has to be tracked separately from `hookTurnOpen` (#1033 round 3): a
   * queued prompt owes a turn that has NOT BEGUN, and the turn that IS running
   * belongs to someone else. Its Stop therefore closes `hookTurnOpen` while
   * our continuation is still sitting in the provider's queue, and the loop
   * cheerfully delivered a second one — the reviewer's probe measured two
   * deliveries where the design promised at most one early. Cleared when the
   * queued prompt is seen to start: a UserPromptSubmit hook, or (for a
   * provider without hooks) the tracked phase going to work. */
  private readonly queuedContinuation = new Set<string>()
  /**
   * Sessions whose last allowed Stop reported background work that will wake
   * the agent by itself (#1138).
   *
   * WHY: Claude Code ends a turn while async subagents or `run_in_background`
   * shells are still running. The agent is not idle; it is waiting, and the
   * CLI re-invokes it with a task-notification when the work finishes. A
   * continuation typed into that gap got "still waiting" and cost one
   * continuation each (observed live 2026-09-22; three in a row).
   *
   * The source is the CLI's own `background_tasks` field on the Stop hook
   * payload (2.1.280+), described by its schema as the way to tell "session is
   * done" from "session is paused waiting for background work". Captured on the
   * wire: testing/fixtures/goal-loop-stop-hooks/. Each Stop REPLACES the set:
   * the notification turn's own Stop reports what is still running, and an
   * empty list releases the hold.
   *
   * The value is when that Stop arrived: a report holds for
   * GOAL_LOOP_BACKGROUND_WORK_LIMIT_MS and then expires on its own, see there.
   *
   * A Stop WITHOUT the field keeps whatever is latched (#1224 review). An
   * older CLI never sends it, so it never latches and nothing changes there;
   * the only other way to lose the field is a Stop body that did not parse,
   * which is forwarded blind so the turn end is not missed. Reading that as
   * "no background work" typed the continuation into exactly the gap this
   * latch protects. Unknown keeps the last known answer, and the window
   * bounds how long that can matter.
   */
  private readonly backgroundWork = new Map<string, number>()

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
  observeProviderHook(
    sessionId: string,
    hook: 'user-prompt-submit' | 'post-tool-use' | 'stop',
    outcome?: { blocked: boolean; backgroundTasks?: readonly GoalLoopBackgroundTask[] },
  ): void {
    this.hookSessions.add(sessionId)
    this.lastHookSessionActivity.set(sessionId, Date.now())
    if (hook !== 'stop') {
      // A prompt entering the model is exactly the evidence a queued
      // continuation was consumed; from here the turn itself holds delivery.
      if (hook === 'user-prompt-submit') this.queuedContinuation.delete(sessionId)
      this.hookTurnOpen.add(sessionId)
      // New work has started (the same turn continuing past another hook's
      // block, or a prompt the user typed). A continuation held from before it
      // is still wanted — this turn's own end is what will deliver it — but
      // its stall deadline must not keep running across work that is
      // legitimately ongoing, or the loop pauses itself for being patient
      // (second #1033 review). Restart the stall clock, keep the continuation.
      this.noteHeldProgress(sessionId)
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
    const reported = outcome?.backgroundTasks
    if (reported?.some(wakesTheAgent)) this.backgroundWork.set(sessionId, Date.now())
    else if (reported) this.backgroundWork.delete(sessionId)
    // The provider says this turn ENDED, so every phase reading that described
    // it is now history — including the busy state we seeded for our own
    // delivery (markOwedATurn), which nothing else would clear on a session
    // whose semantic stream is absent or late.
    //
    // WHY resetting is safe (#1033 round 3): a turn that has ended owes no
    // tool result and is not streaming. Anything the phase says after this
    // point was published AFTER the Stop, which is precisely the evidence the
    // gate wants — the case where another hook blocked ours and the model kept
    // going. The previous version tried to express that with a
    // "has an event arrived since the Stop" flag, and a late event about
    // ALREADY-FINISHED work (a trailing tool_result) validated the stale seed
    // and stalled the loop until the 30-minute pause.
    this.working.delete(sessionId)
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
      // #1040, FIXED at the source: an Esc during a Claude stream used to
      // leave the phase busy forever, because mitmproxy reports a client
      // disconnect only through its `error` hook and the addon implemented
      // none, so `response-end` never arrived. claude-code-headless#61 emits
      // that event and the adapter seals the flow, so such a turn now reaches
      // idle like any other and Resume can close it.
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
    // something; the quiet-turn check (Resume) measures silence from here.
    this.lastHookSessionActivity.set(sessionId, Date.now())
    // And so does a held continuation's stall deadline, for everything except
    // flow bookkeeping.
    //
    // BEFORE the reducer's identity check below (#1033 round 4): a streamed
    // answer is mostly text and thinking deltas, which the reducer collapses
    // to the same state, so a loop held through forty minutes of visible
    // streaming paused itself for "silence" while the model was talking.
    //
    // EXCEPT the proxy's flow bookkeeping (#1033 rounds 5 and 6) — see
    // isAgentProgress. Background chatter about other flows must not be able
    // to postpone a stall pause forever.
    if (isAgentProgress(event)) this.noteHeldProgress(sessionId)
    // Reduce for every session, in every loop phase (see the class comment):
    // only the DECISION to continue is gated on an active loop. The reducer
    // returns the same object for the high-volume delta events, so the common
    // case is one map read and an identity check.
    const state = this.working.get(sessionId) ?? INITIAL_WORKING_STATE
    const next = reduceWorkingState(state, { type: 'semantic', event })
    if (next === state) return
    this.working.set(sessionId, next)
    // Progress. A held continuation's deadlines measure how long we have
    // waited with NOTHING happening, not how long we have waited (#1033
    // round 3): an agent that keeps working past the stall deadline is the
    // one case where pausing the loop is plainly wrong, and it was reachable
    // — a reopened turn streaming every minute for thirty minutes paused
    // itself. Restart the clock on anything that changed the tracked state.
    // A queued continuation that has begun. For a provider WITHOUT hooks this
    // phase edge is the only signal that the queue drained; for a hook-driven
    // one it is a false positive waiting to happen — a Claude subagent flow
    // publishes exactly this edge mid-turn (#1024), and the reviewer used
    // that recorded sequence to release a queued continuation and deliver a
    // second one without any UserPromptSubmit. Hook sessions wait for the
    // hook.
    if (!this.hookSessions.has(sessionId) && isWorking(next) && !isWorking(state)) {
      this.queuedContinuation.delete(sessionId)
    }
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
    this.queuedContinuation.delete(sessionId)
    // Background tasks belonged to the dead process; they will never notify.
    this.backgroundWork.delete(sessionId)
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
  private deliveryHold(sessionId: string): 'turn-open' | 'queued' | 'background-work' | 'phase-working' | 'screen-busy' | null {
    if (this.hookSessions.has(sessionId) && this.hookTurnOpen.has(sessionId)) return 'turn-open'
    if (this.queuedContinuation.has(sessionId)) return 'queued'
    if (this.backgroundWorkHolds(sessionId)) return 'background-work'
    const tracked = this.working.get(sessionId)
    if (tracked && (isWorking(tracked) || tracked.pendingTools.length > 0)) return 'phase-working'
    const active = this.deps.manager.getProcessStateSnapshot(sessionId)?.active === true
    if (active && this.heldForMs(sessionId) < GOAL_LOOP_ACTIVITY_GRACE_MS) return 'screen-busy'
    return null
  }

  /** Something happened, so a held continuation has not been waiting on a
   * stuck signal. Both deadlines (the 45 s screen grace and the 30 min stall
   * pause) hang off this instant. */
  private noteHeldProgress(sessionId: string): void {
    if (this.progressSince.has(sessionId)) this.progressSince.set(sessionId, Date.now())
  }

  /** Does the last Stop's background-work report still hold delivery? An
   * expired report is dropped here, so the silence exemption above and the
   * gate agree on one answer (a stale latch must not keep suppressing the
   * 30-minute silence pause of an unrelated turn-open hold). */
  private backgroundWorkHolds(sessionId: string): boolean {
    const since = this.backgroundWork.get(sessionId)
    if (since === undefined) return false
    if (Date.now() - since < GOAL_LOOP_BACKGROUND_WORK_LIMIT_MS) return true
    this.backgroundWork.delete(sessionId)
    return false
  }

  private heldForMs(sessionId: string): number {
    const since = this.heldSince.get(sessionId)
    return since === undefined ? 0 : Date.now() - since
  }

  /**
   * Is a tool actually running for this session right now?
   *
   * A pending tool the provider is still waiting on, with a live process
   * behind it, is not a stuck signal — it is a build, a test suite, an
   * install. The stall pause exists for signals that will never resolve, and
   * firing it here cost a loop its own turn: the tool's eventual result and
   * Stop cannot continue a loop that has already been paused (#1033 round 6,
   * reproduced with a 30-minute tool run and no traffic but flow
   * bookkeeping).
   *
   * BOTH halves are required. A pending tool alone can be a leftover of a
   * turn whose process died, and an active process alone is the latching
   * screen detector the grace above already bounds.
   */
  private toolIsRunning(sessionId: string): boolean {
    const tracked = this.working.get(sessionId)
    // Two shapes, because the two providers report a dispatched tool
    // differently: `pendingTools` is filled by tool BLOCKS (Claude's
    // block_started, Codex's tool_started), while a Claude stream that is
    // parked on a tool publishes `stream_phase: awaiting-tool` carrying the
    // tool's id and nothing else. Either one means a tool was dispatched and
    // has not come back.
    const dispatched = tracked
      ? tracked.pendingTools.length > 0 || (tracked.phase === 'awaiting-tool' && tracked.pendingToolUseId !== null)
      : false
    if (!dispatched) return false
    return this.deps.manager.getProcessStateSnapshot(sessionId)?.active === true
  }

  private quietWhileHeldMs(sessionId: string): number {
    const since = this.progressSince.get(sessionId)
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
    if (!this.heldSince.has(sessionId)) {
      this.heldSince.set(sessionId, Date.now())
      this.progressSince.set(sessionId, Date.now())
    }
    // Background work the CLI reported is exempt from the SILENCE pause, like
    // a running tool: a background implementer routinely runs 20–40 minutes
    // with no turn in between, and pausing here would leave the loop paused
    // when its notification turn arrives, so nothing would continue it
    // (#1138). The exemption lasts only as long as the report does
    // (GOAL_LOOP_BACKGROUND_WORK_LIMIT_MS), and the absolute limit below
    // still applies.
    const silent = this.quietWhileHeldMs(sessionId) >= GOAL_LOOP_HOLD_STALL_MS
      && !this.toolIsRunning(sessionId)
      && !this.backgroundWorkHolds(sessionId)
    if (silent || this.heldForMs(sessionId) >= GOAL_LOOP_HOLD_LIMIT_MS) {
      this.pauseStalledHold(sessionId, silent ? reason : `${reason} (held ${Math.round(this.heldForMs(sessionId) / 60_000)} min)`)
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
    this.progressSince.delete(sessionId)
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
    // The latch goes with it. If we are pausing, whatever we were waiting for
    // did not arrive — a queued prompt the user cleared, a start signal the
    // provider never sent — and keeping the latch made Resume useless: it
    // re-held on the same stale reason and paused again half an hour later
    // without ever delivering (#1033 round 4). The user asking for a retry is
    // the signal that the queue is no longer what it was.
    this.queuedContinuation.delete(sessionId)
    // Same for reported background work (#1138): a pause means it outlived the
    // absolute limit, and a Resume is the user saying continue anyway.
    this.backgroundWork.delete(sessionId)
    const loop = this.loops.get(sessionId)
    if (!loop || loop.phase !== 'active') return
    console.warn(`[goal-loop] ${sessionId}: held on "${reason}" after its turn ended; pausing instead of typing into it`)
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
      // The provider took the prompt into its QUEUE instead of starting a turn
      // with it, which is what happens when the delivery lands mid-turn. It
      // will run, but not yet, and until it does nothing else may be sent:
      // the running turn's own Stop must not be mistaken for ours.
      if (result.ok && result.acceptance?.kind === 'queue') this.queuedContinuation.add(sessionId)
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
