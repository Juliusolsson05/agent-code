// Grok terminal runtime: the AgentSession adapter for native Grok Build.
//
// This class is a thin translator, the job OpencodeTerminalSession does for
// OpenCode: it starts the app-owned helpers in the one order the recordings
// prove (leader leader → session over control → guard → prepared launch →
// terminal PTY), constructs GrokHeadless around them, and maps the package's
// events onto the AgentSession contract SessionManager already speaks.
// Everything about HOW native Grok is observed — acceptance, queue semantics,
// durable history, rewrite snapshots, reverse requests — lives in the
// grok-code-headless package (testing/fixtures/controlled-runtime/contract.md).
//
// WHAT THIS WRAPPER STILL OWNS (and nothing else):
// - start order and rollback: the terminal uses connect-or-spawn for its
//   leader, so the owned leader and the guard must exist BEFORE the PTY spawns
//   or the terminal launches an unowned leader (contract.md "Root class
//   shape"). A failure at any step rolls back every earlier resource in
//   reverse order, in the guarded-spawn shape of claudeSession/codexSession.
// - session identity: the app allocates the Grok session id (a UUID, which is
//   what native validates) and creates the session over control BEFORE any
//   terminal exists; the terminal attaches with `--resume <id>`.
// - the MCP set: seeded at session creation, and re-seeded when native answers
//   the terminal's load, because that load carries an empty set and clears
//   what the control connection configured (catalog tool.mcp).
// - the session-switched fence: once the terminal moves to another
//   conversation this pane stops forwarding input and reports not ready; the
//   user resumes the other conversation explicitly (decision
//   terminal-conversation-change: the app session owns the fence).
// - generation fencing against stop() racing start().
//
// WHY prompts never touch the PTY: acceptance is correlated by the client
// prompt id over the control connection (catalog prompt.acceptance), and a
// paste into the native TUI can attach clipboard images the composer never
// saw. Typing in the terminal remains the user's own path.

import { EventEmitter } from 'events'
import { randomUUID } from 'node:crypto'
import { spawn as ptySpawn } from 'node-pty'
import type { IPty } from 'node-pty'
import {
  GrokHeadless,
  GrokNativeControl,
  GrokTuiSocketGuard,
  prepareGrokTerminalLaunch,
  type GrokMcpServer,
  type GrokTerminalLaunch,
  type GrokTuiGuardFault,
} from 'grok-code-headless'

import type { ConditionCustomAction } from '@shared/types/providerConditions.js'
import type { AgentSession, AgentSessionEvents, SessionOptions } from '@shared/types/session.js'

// The native TUI paints its composer quickly, but nothing native publishes a
// machine-readable readiness signal. Same heuristic as OpenCode Terminal: first
// output proves the UI was reached, one short fixed grace lets key handlers
// mount, and it gates nothing programmatic — prompts wait for control
// acceptance, never for paint.
const TUI_READY_GRACE_MS = 250
// Upper bound on waiting for a killed terminal's exit acknowledgement inside
// guard disposal. See releaseHelpers for why this exists at all.
const GUARD_EXIT_ACK_MS = 2_000

function waitFor(ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    // A teardown path must never keep the host process alive on its own.
    if (typeof timer === 'object' && 'unref' in timer) (timer as { unref(): void }).unref()
  })
}

class GrokTerminalNotReadyError extends Error {
  readonly code = 'grok-terminal-not-ready'
}

/**
 * The server answered, and its answer was no.
 *
 * WHY distinct from the generic failure: `refused` is the one outcome that
 * proves native never accepted the prompt (control.rpc-failure), so nothing
 * ran — reporting `promptWritten: true` would make a caller discard a draft it
 * may still want. It is still not retry-safe: resending a refused prompt only
 * produces the same refusal.
 */
class GrokTerminalRejectedError extends Error {
  readonly code = 'grok-terminal-rejected'
}

/**
 * Injection seams. Production uses the defaults; tests replace the PTY spawn
 * and the helper starts (no real leader, no real guard socket) while the
 * headless itself is always the real package, so adapter tests exercise the
 * same composition Agent Code ships.
 */
export type GrokSessionDeps = {
  spawnPty?: typeof ptySpawn
  startControl?: typeof GrokNativeControl.start
  createGuard?: typeof GrokTuiSocketGuard.create
  prepareLaunch?: typeof prepareGrokTerminalLaunch
  /** Extra GrokHeadless options (timers for tests). */
  headlessOptions?: Partial<ConstructorParameters<typeof GrokHeadless>[0]>
}

export interface GrokSession {
  on<K extends keyof AgentSessionEvents>(event: K, listener: (...args: AgentSessionEvents[K]) => void): this
  off<K extends keyof AgentSessionEvents>(event: K, listener: (...args: AgentSessionEvents[K]) => void): this
  once<K extends keyof AgentSessionEvents>(event: K, listener: (...args: AgentSessionEvents[K]) => void): this
  emit<K extends keyof AgentSessionEvents>(event: K, ...args: AgentSessionEvents[K]): boolean
}

export class GrokSession extends EventEmitter implements AgentSession {
  private pty: IPty | null = null
  private headless: GrokHeadless | null = null
  private control: GrokNativeControl | null = null
  private guard: GrokTuiSocketGuard | null = null
  private exited = false
  private fenced = false
  private startGeneration = 0
  private ptyDataSubscription: { dispose(): void } | null = null
  private providerSessionId: string | null = null
  private readinessTimer: ReturnType<typeof setTimeout> | null = null
  private mcpSeed: GrokMcpServer[] = []
  private ptyExit: Promise<void> = Promise.resolve()

  private readonly cwd: string
  private readonly cols: number
  private readonly rows: number
  private readonly binary: string
  private readonly extraEnv: Record<string, string | undefined>
  private readonly resumeSessionId: string | null
  private readonly builtInMcpServers: NonNullable<SessionOptions['builtInMcpServers']>
  private readonly deps: Required<Pick<GrokSessionDeps, 'spawnPty' | 'startControl' | 'createGuard' | 'prepareLaunch'>> & Pick<GrokSessionDeps, 'headlessOptions'>

  constructor(options: SessionOptions, deps: GrokSessionDeps = {}) {
    super()
    this.cwd = options.cwd
    this.cols = options.cols ?? 120
    this.rows = options.rows ?? 40
    this.binary = options.binary ?? 'grok'
    this.extraEnv = options.env ?? {}
    this.resumeSessionId = options.resumeSessionId ?? null
    this.builtInMcpServers = options.builtInMcpServers ?? []
    this.deps = {
      spawnPty: deps.spawnPty ?? ptySpawn,
      startControl: deps.startControl ?? GrokNativeControl.start,
      createGuard: deps.createGuard ?? GrokTuiSocketGuard.create,
      prepareLaunch: deps.prepareLaunch ?? prepareGrokTerminalLaunch,
      headlessOptions: deps.headlessOptions,
    }
  }

  async start(): Promise<void> {
    if (this.control) throw new Error('GrokSession already started')
    const generation = ++this.startGeneration
    this.exited = false
    this.fenced = false
    this.emit('input-readiness', { ready: false, reason: 'starting' })

    // Same environment policy as the siblings: complete inherited environment
    // (a GUI-launched app needs PATH/HOME/credentials), caller overrides last,
    // undefined removes. Kept in a one-start local object so MCP bearer
    // variables cannot linger on a reusable wrapper.
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === 'string') env[key] = value
    }
    for (const [key, value] of Object.entries(this.extraEnv)) {
      if (value === undefined) delete env[key]
      else env[key] = value
    }

    // The app owns the process tree: leader first, session over control, guard,
    // only then the terminal. Each helper that came up must go away again if a
    // later step fails; rollbackStart disposes in reverse order.
    this.mcpSeed = this.toGrokMcpServers(this.builtInMcpServers)
    const sessionId = this.resumeSessionId ?? randomUUID()
    let control: GrokNativeControl | null = null
    let guard: GrokTuiSocketGuard | null = null
    let pty: IPty | null = null
    // WHY a local disposer: teardown() can only release helpers it can see on
    // fields, and a stop() that wins WHILE an await here is pending bumps the
    // generation before the assignment below runs. Every stale-generation exit
    // in this try block must dispose exactly what THIS attempt already created
    // (the codex start-attempt shape, reduced to Grok's three resources).
    const disposeStaleAttempt = async (): Promise<void> => {
      try { pty?.kill() } catch { /* the process may have won the exit race */ }
      try {
        if (guard) await Promise.race([guard.dispose(() => this.ptyExit), waitFor(GUARD_EXIT_ACK_MS)])
      } catch { /* cleanup must not mask the abandon */ }
      try { await control?.dispose() } catch { /* single-flight; a close may have won */ }
    }
    try {
      control = await this.deps.startControl({ binary: this.binary, cwd: this.cwd, env })
      if (generation !== this.startGeneration) { await disposeStaleAttempt(); return }
      this.control = control
      // The session must exist before the terminal attaches with `--resume`.
      // A FRESH pane creates it over control with the MCP seed (recorded:
      // session/new before the terminal spawns). A RESUME deliberately sends
      // nothing over control: the recorded restart-resume epoch shows only the
      // terminal loading (the terminal's --resume attach) and control
      // re-seeding MCP on the load answer — a control session/load in a
      // resumed epoch is an open gap in the catalog and must not be guessed.
      if (!this.resumeSessionId) await control.createSession(sessionId, this.mcpSeed)
      if (generation !== this.startGeneration) { await disposeStaleAttempt(); return }

      guard = await this.deps.createGuard({
        upstreamPath: control.socketPath,
        expectedPid: control.pid!,
        onFault: reason => this.handleGuardFault(reason),
      })
      if (generation !== this.startGeneration) { await disposeStaleAttempt(); return }
      this.guard = guard

      const launch = this.deps.prepareLaunch({
        binary: this.binary,
        env,
        sessionId,
        guardSocketPath: guard.socketPath,
      })
      if (generation !== this.startGeneration) { await disposeStaleAttempt(); return }

      pty = this.deps.spawnPty(launch.binary, launch.args, {
        name: 'xterm-256color',
        cols: this.cols,
        rows: this.rows,
        cwd: this.cwd,
        env: launch.env,
      })
      this.pty = pty
      this.providerSessionId = sessionId

      this.ptyExit = new Promise(resolve => {
        pty!.onExit(() => resolve())
      })
      this.ptyDataSubscription = pty.onData(data => {
        if (generation !== this.startGeneration || this.pty !== pty || this.exited) return
        // SessionManager's capped attach/replay buffer is what makes a TUI
        // launched before React mounts appear complete instead of blank.
        this.emit('pty-data', data)
        if (!this.readinessTimer) {
          this.readinessTimer = setTimeout(() => {
            this.readinessTimer = null
            // `fenced` too: the grace can fire after the terminal switched to
            // another conversation, and reporting ready would undo the fence.
            if (generation !== this.startGeneration || this.pty !== pty || this.exited || this.fenced) return
            this.emit('input-readiness', { ready: true, reason: 'ready' })
          }, TUI_READY_GRACE_MS)
        }
      })

      // Narrowed once so the handle's getter can never read a null local after
      // TypeScript's flow analysis gives up inside the object literal.
      const ownedControl = control
      const headless = new GrokHeadless({
        ...(this.deps.headlessOptions ?? {}),
        pty,
        cwd: this.cwd,
        launch,
        // Structural handle: the control helper IS the rpc surface; wrapping
        // keeps GrokHeadless's narrow structural type out of the app's imports.
        // WHY a getter and not a snapshot: `isClosed` captured at construction stays
        // false forever after the lifetime closes, and submitPrompt's closed check
        // would pass a closed control through to a throw.
        control: { get isClosed() { return ownedControl.isClosed }, rpc: ownedControl, observe: observer => ownedControl.observe(observer) },
        guard,
        resume: this.resumeSessionId !== null,
      })
      this.headless = headless
      this.forwardHeadless(headless, pty)

      await headless.start()
      if (generation !== this.startGeneration || this.headless !== headless || this.pty !== pty || this.exited) return

      // Identity-only envelope through the durable path, exactly like OpenCode
      // Terminal: the grok mapper renders no row for this shape while its
      // extractor records the id for reload/switch/recovery.
      this.emit('jsonl-entry', { sessionID: sessionId }, headless.getTranscriptFile())
      this.emit('process-state', { active: false })
      this.emit('started', {})
    } catch (error) {
      await this.rollbackStart()
      throw error
    }
  }

  /**
   * Map the package's events onto the AgentSession contract.
   *
   * WHY exit is taken from the headless and not node-pty: when the terminal
   * dies mid-turn the headless first drains what native committed and closes
   // the turn (turn_completed, idle, inactive activity, cleared conditions);
   * forwarding node-pty's exit directly would let SessionManager tear the pane
   * down before those closing events arrive, leaving a pane that was busy at
   * the moment of death looking busy forever.
   */
  private forwardHeadless(headless: GrokHeadless, pty: IPty): void {
    headless.on('activity', ({ active, status }) => {
      this.emit('process-state', status ? { active, status } : { active })
    })
    headless.on('semantic', event => this.emit('semantic-event', event))
    headless.on('entry', record => this.emit('jsonl-entry', record, headless.getTranscriptFile()))
    headless.on('history', boundary => {
      // Flat payload per ProviderHistoryBoundaryEvent; the package's sessionId
      // field is dropped because the session identity is this pane's own state.
      this.emit('history-boundary', {
        type: boundary.type, generation: boundary.generation, snapshotByteLength: boundary.snapshotByteLength,
        ...('byteOffset' in boundary ? { byteOffset: boundary.byteOffset } : {}),
        ...('complete' in boundary ? { complete: boundary.complete } : {}),
        file: headless.getTranscriptFile(),
      })
    })
    headless.on('conditions', snapshot => {
      // WHY the cast: the shared snapshot's provider union is AgentProviderKind,
      // and adding 'grok' to that kind is Stage 6 registration (it trips the
      // five-registry compile checklist on purpose). The snapshot's shape is the
      // shared conditions core's, which this package builds its modules on, so
      // the cast is a kind-label widening, not a structural one.
      this.emit('conditions', snapshot as unknown as AgentSessionEvents['conditions'][0])
    })
    headless.on('session-switched', ({ to }) => {
      // The fence the contract requires (decision terminal-conversation-change):
      // this pane stops forwarding input and reports not ready. The user
      // resumes the other conversation explicitly; nothing here guesses
      // whether the terminal ever comes back on its own (unrecorded).
      this.fenced = true
      this.emit('input-readiness', { ready: false, reason: 'provider-not-ready' })
      const from = this.providerSessionId
      this.emit('jsonl-error', Object.assign(new Error(
        `Grok switched to session ${to} inside the terminal. This pane still follows ${from}. Resume ${to} from the Resume picker to follow it. (provider_session_switched)`,
      ), { code: 'provider_session_switched' }))
    })
    headless.on('terminal-loaded', () => {
      // The terminal's attach load carries an empty MCP set and clears the
      // session's servers (catalog tool.mcp); this is the recorded moment to
      // put the app's set back. Deliberately no renderer event: this is
      // provider plumbing, not user-visible state.
      const control = this.control
      const sessionId = this.providerSessionId
      if (!control || control.isClosed || !sessionId) return
      void control.updateMcpServers(sessionId, this.mcpSeed).catch(() => {
        // A failed re-seed leaves the session without the app's MCP servers;
        // the durable diagnostic surfaces it without tearing the pane down,
        // because control, turns and history are all still alive.
        this.emit('transcript-diagnostic', { kind: 'grok-mcp-reseed-failed' })
      })
    })
    headless.on('transcript-error', error => {
      // Custom Error properties disappear across IPC; keep the category in the
      // message so renderer/phone can retain the actual diagnosis.
      this.emit('jsonl-error', Object.assign(new Error(`Grok ${error.channel} channel (${error.code}): ${error.message}`), { code: error.code }))
    })
    headless.on('live-state', state => {
      this.emit('transcript-diagnostic', { kind: 'grok-live-state', ...state })
      // WHY an error and not just a diagnostic: a closed control connection is
      // the pane losing its agent (leader loss) — open turns ended uncertain
      // and no prompt can be delivered until the pane is restarted. A
      // diagnostic alone renders nowhere the user will see it.
      if (!state.connected) {
        this.emit('jsonl-error', Object.assign(new Error(
          `Grok control connection lost${state.reason ? ` (${state.reason})` : ''}. Running work ended uncertain; restart the pane to continue. (grok_live_disconnected)`,
        ), { code: 'grok_live_disconnected' }))
      }
    })
    headless.on('terminal-load-refused', ({ sessionId }) => {
      // The resume path's only load was refused (session.load-failure): the
      // terminal is attached to a conversation it cannot show and the MCP
      // re-seed will never fire. This is a failed resume, surfaced as such.
      this.emit('jsonl-error', Object.assign(new Error(
        `Grok refused to resume session ${sessionId}. The stored conversation may be unreadable; start a fresh pane instead. (grok_resume_failed)`,
      ), { code: 'grok_resume_failed' }))
    })
    headless.on('exit', ({ exitCode, signal }) => {
      if (this.pty !== pty) return
      this.pty = null
      this.headless = null
      this.exited = true
      this.ptyDataSubscription?.dispose()
      this.ptyDataSubscription = null
      this.clearReadinessTimer()
      this.emit('input-readiness', { ready: false, reason: 'provider-not-ready' })
      this.emit('process-state', { active: false })
      this.emit('exit', { exitCode, signal })
      // WHY ownership ends here: the terminal was the guard's only dependent
      // and nothing can attach to the leader anymore, so keeping them only
      // leaks two processes until an explicit stop() that may never come (the
      // pane is gone). The headless already drained the durable channel; this
      // releases the helpers without touching the dead PTY. Idempotent by
      // field-nilling, so a later stop() is a no-op for them.
      void this.releaseHelpers()
    })
  }

  private handleGuardFault(reason: GrokTuiGuardFault): void {
    // The guard holds the terminal on any fault (it never reconnects or
    // spawns); the durable diagnostic says why. Leader loss also closes the
    // control connection, which surfaces through live-state and settles open
    // turns uncertain — this only adds the reason the holder stopped.
    this.emit('transcript-diagnostic', { kind: 'grok-guard-fault', reason })
  }

  write(data: string): void {
    // The fence from session-switched: bytes typed into a pane that follows a
    // different conversation would land in the wrong chat. Drop them; the
    // pane already reported not ready and named the conversation to resume.
    if (this.fenced) return
    this.pty?.write(data)
  }

  /**
   * WHY programmatic prompts go over control: acceptance is the first queue
   * notification naming the client prompt id (catalog prompt.acceptance), and
   * a PTY paste proves neither delivery nor identity. Outcome mapping:
   * - not-sent → not-ready (nothing was written; retry is safe)
   * - refused → rejected (native's definite no; nothing ran)
   * - uncertain/unconfirmed → generic failure with the write reported as
   *   possibly performed: native may already be running the turn, and the
   *   uncertain-prompts decision forbids ever resending it.
   */
  async deliverPromptText(text: string): Promise<void> {
    const headless = this.headless
    if (!headless || this.exited) {
      throw new GrokTerminalNotReadyError('Grok terminal is not running')
    }
    const result = await headless.submitPrompt(text)
    if (result.ok) return
    if (result.reason === 'not-sent') {
      throw new GrokTerminalNotReadyError(result.detail ?? 'Grok control connection is not ready')
    }
    if (result.reason === 'refused') {
      throw new GrokTerminalRejectedError(result.detail ?? 'Grok refused the prompt')
    }
    throw new Error(result.detail ?? `Grok prompt delivery outcome is ${result.reason}`)
  }

  /**
   * Stop the running turn the recorded way: `session/cancel` over control
   * (catalog prompt.cancel). Queued prompts keep their place and still run
   * (decision stop-scope); a turn typed in the terminal is cancelled too
   * (decision stop-foreign-turn). True means the cancel was written, not that
   * the turn ended — its completion event reports that.
   */
  async cancelRunningTurn(): Promise<boolean> {
    const headless = this.headless
    if (!headless || this.exited) return false
    return headless.cancelTurn()
  }

  /**
   * Answer an outstanding permission, question or plan approval over control.
   * The headless refuses stale tokens before writing (interaction.permission),
   * so a request the terminal already resolved cannot be answered twice; the
   * generation fence keeps an in-flight HTTP acceptance from acknowledging a
   * backend its owner already replaced.
   */
  async resolveCondition(
    action: ConditionCustomAction,
  ): Promise<
    | { ok: true; state?: unknown }
    | { ok: false; reason: string; lastState?: unknown; failedAtStep?: string }
  > {
    const headless = this.headless
    if (!headless) return { ok: false, reason: 'no-headless' }
    const generation = this.startGeneration
    const result = await headless.resolveConditionAction(action)
    if (generation !== this.startGeneration || this.headless !== headless || this.exited) {
      return { ok: false, reason: 'cancelled' }
    }
    return result
  }

  resize(cols: number, rows: number): void {
    try {
      this.pty?.resize(cols, rows)
    } catch {
      // Layout transitions can briefly report 0x0; the next FitAddon
      // measurement supplies a valid size, so killing the agent over a
      // transient would be strictly worse than dropping one resize.
    }
  }

  getProcessPid(): number | null {
    return this.pty?.pid ?? null
  }

  isExited(): boolean {
    return this.exited
  }

  getTranscriptFile(): string | null {
    return this.headless?.getTranscriptFile() ?? null
  }

  getProviderSessionId(): string | null {
    return this.providerSessionId
  }

  async stop(): Promise<void> {
    this.startGeneration += 1
    await this.teardown()
  }

  /**
   * Roll back a failed start AND tear down a stopped session, in the one order
   * that respects native's connect-or-spawn: the headless detaches first (it
   * owns nothing), the terminal PTY dies next (it is the guard's dependent),
   * the guard acknowledges that exit before releasing its socket, and the
   * leader goes last so the guard never watches a dead upstream. Every step is
   * individually guarded so cleanup cannot mask the original failure.
   */
  private async rollbackStart(): Promise<void> {
    await this.teardown()
  }

  private async teardown(): Promise<void> {
    this.exited = true
    this.ptyDataSubscription?.dispose()
    this.ptyDataSubscription = null
    this.clearReadinessTimer()
    const headless = this.headless
    this.headless = null
    const pty = this.pty
    this.pty = null
    try { await headless?.stop() } catch { /* detach-only; nothing to preserve */ }
    try { pty?.kill() } catch { /* node-pty throws if the process won the race */ }
    await this.releaseHelpers()
  }

  /**
   * Release the guard and the leader exactly once. WHY the bounded wait: the
   * guard's dispose waits for the terminal's exit acknowledgement, and a
   * terminal that ignores SIGKILL's exit callback would otherwise hang pane
   * teardown forever. Two seconds is far beyond a normal kill round-trip; past
   * it the socket directory is left to the OS temp cleaner and teardown moves
   * on — a leaked directory beats a leaked session lifecycle.
   */
  private async releaseHelpers(): Promise<void> {
    const guard = this.guard
    this.guard = null
    const control = this.control
    this.control = null
    try {
      if (guard) await Promise.race([guard.dispose(() => this.ptyExit), waitFor(GUARD_EXIT_ACK_MS)])
    } catch { /* socket release is best-effort at teardown */ }
    try { await control?.dispose() } catch { /* dispose is single-flight; a concurrent close already won */ }
  }

  private clearReadinessTimer(): void {
    if (!this.readinessTimer) return
    clearTimeout(this.readinessTimer)
    this.readinessTimer = null
  }

  /** SessionOptions.builtInMcpServers (app domains) → the package's http server shape. */
  private toGrokMcpServers(servers: NonNullable<SessionOptions['builtInMcpServers']>): GrokMcpServer[] {
    const grok: GrokMcpServer[] = []
    // The app's built-in configs are all http servers with an optional bearer
    // (kept OUT of headers so launchers never publish it); Grok's native server
    // shape takes headers as a list, bearer included.
    for (const server of servers) {
      const headers = Object.entries(server.headers ?? {}).map(([name, value]) => ({ name, value }))
      if (server.bearerToken) headers.push({ name: 'Authorization', value: `Bearer ${server.bearerToken}` })
      grok.push({ type: 'http', name: server.name, url: server.url, headers })
    }
    return grok
  }
}
