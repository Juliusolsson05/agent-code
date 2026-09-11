import { excludeExternalControlFromOpencode } from '@providers/shared/runtime/externalControlExclusion.js'
import { EventEmitter } from 'events'
import { spawn as ptySpawn } from 'node-pty'
import type { IPty } from 'node-pty'
import {
  OpencodeTerminalHeadless,
  prepareOpencodeTerminalLaunch,
  type OpencodeTerminalHeadlessOptions,
} from 'opencode-terminal-headless'

import { addOpencodeBuiltInMcpLaunchConfig } from '@providers/shared/runtime/builtInMcpLaunch.js'
import { createEmptyOpencodeSession } from './opencodeCliSessions.js'
import type { ConditionCustomAction } from '@shared/types/providerConditions.js'
import type {
  AgentSession,
  AgentSessionEvents,
  SessionOptions,
} from '@shared/types/session.js'

const TUI_READY_GRACE_MS = 250

class OpencodeTerminalNotReadyError extends Error {
  readonly code = 'opencode-terminal-not-ready'
}

/**
 * Injection seams. Production uses the defaults; tests replace the PTY spawn
 * (no real TUI) and the launch step (point the reader at a recorded replay).
 * The headless itself is always the real package, so adapter tests exercise
 * the same reader Agent Code ships.
 */
export type OpencodeTerminalSessionDeps = {
  spawnPty?: typeof ptySpawn
  prepareLaunch?: typeof prepareOpencodeTerminalLaunch
  headlessOptions?: Partial<Omit<OpencodeTerminalHeadlessOptions, 'pty' | 'cwd' | 'launch'>>
}

/**
 * Native OpenCode TUI runtime.
 *
 * This class is a thin translator, the job ClaudeSession does for Claude: it
 * spawns the TUI in a PTY and maps `opencode-terminal-headless` events onto the
 * AgentSession contract SessionManager already speaks. Everything about HOW the
 * native TUI is observed — OpenCode's durable event log for committed messages,
 * the TUI's own server for activity, turns and permission/question prompts —
 * lives in that package (see its README and Agent Code
 * docs/decomposition/opencode-terminal-headless.md).
 *
 * WHY this is not part of opencode-headless: that package owns OpenCode's
 * `serve` integration for the structured runtime and is deliberately not a
 * terminal wrapper. The native TUI is a different process shape (caller-owned
 * PTY), so it gets its own headless package, like Claude and Codex.
 *
 * What this wrapper still owns, unchanged from the PR #755 runtime:
 * - session identity: fresh panes pre-create a `ses_` id through the supported
 *   `opencode import` boundary, because the TUI never prints its id
 * - skills and scoped built-in MCP config through `OPENCODE_CONFIG_CONTENT`
 * - UI input readiness (first paint + grace) and server-acknowledged prompts
 * - generation fencing against stop() racing start()
 */
export interface OpencodeTerminalSession {
  on<K extends keyof AgentSessionEvents>(
    event: K,
    listener: (...args: AgentSessionEvents[K]) => void,
  ): this
  off<K extends keyof AgentSessionEvents>(
    event: K,
    listener: (...args: AgentSessionEvents[K]) => void,
  ): this
  once<K extends keyof AgentSessionEvents>(
    event: K,
    listener: (...args: AgentSessionEvents[K]) => void,
  ): this
  emit<K extends keyof AgentSessionEvents>(
    event: K,
    ...args: AgentSessionEvents[K]
  ): boolean
}

export class OpencodeTerminalSession extends EventEmitter implements AgentSession {
  private pty: IPty | null = null
  private headless: OpencodeTerminalHeadless | null = null
  private exited = false
  private startGeneration = 0
  private importAbort: AbortController | null = null
  private ptyDataSubscription: { dispose(): void } | null = null
  private providerSessionId: string | null = null
  private readinessTimer: ReturnType<typeof setTimeout> | null = null

  private readonly cwd: string
  private readonly cols: number
  private readonly rows: number
  private readonly binary: string
  private readonly extraEnv: Record<string, string | undefined>
  private readonly resumeSessionId: string | null
  private readonly dangerousMode: boolean
  private readonly builtInMcpServers: NonNullable<SessionOptions['builtInMcpServers']>
  private readonly deps: Required<Pick<OpencodeTerminalSessionDeps, 'spawnPty' | 'prepareLaunch'>> & Pick<OpencodeTerminalSessionDeps, 'headlessOptions'>

  constructor(options: SessionOptions, deps: OpencodeTerminalSessionDeps = {}) {
    super()
    this.cwd = options.cwd
    this.cols = options.cols ?? 120
    this.rows = options.rows ?? 40
    this.binary = options.binary ?? 'opencode'
    this.extraEnv = options.env ?? {}
    this.resumeSessionId = options.resumeSessionId ?? null
    this.dangerousMode = options.dangerousMode === true
    this.builtInMcpServers = options.builtInMcpServers ?? []
    this.deps = {
      spawnPty: deps.spawnPty ?? ptySpawn,
      prepareLaunch: deps.prepareLaunch ?? prepareOpencodeTerminalLaunch,
      headlessOptions: deps.headlessOptions,
    }
  }

  async start(): Promise<void> {
    if (this.pty) throw new Error('OpencodeTerminalSession already started')
    const generation = ++this.startGeneration
    this.exited = false
    this.emit('input-readiness', { ready: false, reason: 'starting' })

    // Start from the complete inherited environment: a GUI-launched app still
    // needs PATH/HOME and provider credentials. Caller overrides win last, and
    // undefined explicitly removes an inherited value. MCP config is added to
    // this one-start local object so its bearer variables cannot linger on a
    // reusable wrapper after stop.
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === 'string') env[key] = value
    }
    env.TERM = 'xterm-256color'
    env.COLORTERM = 'truecolor'
    for (const [key, value] of Object.entries(this.extraEnv)) {
      if (value === undefined) delete env[key]
      else env[key] = value
    }
    addOpencodeBuiltInMcpLaunchConfig(this.builtInMcpServers, env)
    excludeExternalControlFromOpencode(env)

    let providerSessionId = this.resumeSessionId
    if (!providerSessionId) {
      const controller = new AbortController()
      this.importAbort = controller
      try {
        providerSessionId = await createEmptyOpencodeSession({
          binary: this.binary,
          cwd: this.cwd,
          env,
          signal: controller.signal,
        })
      } catch (error) {
        // Cancellation is an expected stop outcome, not a failed pane startup.
        // The CLI helper owns killing its child and removing the import file;
        // this generation may never proceed into launch after that cleanup.
        if (controller.signal.aborted) return
        throw error
      } finally {
        if (this.importAbort === controller) this.importAbort = null
      }
    }
    if (generation !== this.startGeneration) return
    this.providerSessionId = providerSessionId

    // The launch step adds what makes the TUI observable: a loopback server
    // with a per-spawn password (env only, never argv), and the database path
    // the durable reader tails. OpenCode's `--auto` still carries Agent Code's
    // provider-neutral dangerous mode.
    const launch = await this.deps.prepareLaunch({
      binary: this.binary,
      cwd: this.cwd,
      env,
      sessionID: providerSessionId,
      dangerousMode: this.dangerousMode,
    })
    if (generation !== this.startGeneration) return

    const pty = this.deps.spawnPty(launch.binary, launch.args, {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      env: launch.env,
    })
    this.pty = pty

    this.ptyDataSubscription = pty.onData(data => {
      if (generation !== this.startGeneration || this.pty !== pty || this.exited) return
      // SessionManager already owns a capped attach/replay buffer for agent PTY
      // bytes. Forwarding the native stream through that channel is what makes
      // a TUI launched before React mounts appear complete instead of blank.
      this.emit('pty-data', data)
      if (!this.readinessTimer) {
        // Native OpenCode does not publish a machine-readable "composer ready"
        // event. First output proves the process reached its terminal UI; one
        // short fixed grace lets the initial layout and key handlers mount.
        // This is deliberately NOT a quiet-period debounce: animated spinners
        // can redraw forever. This is only a UI hint: programmatic delivery
        // waits for the server, never for this heuristic (#877).
        this.readinessTimer = setTimeout(() => {
          this.readinessTimer = null
          if (generation !== this.startGeneration || this.pty !== pty || this.exited) return
          this.emit('input-readiness', { ready: true, reason: 'ready' })
        }, TUI_READY_GRACE_MS)
      }
    })

    const headless = new OpencodeTerminalHeadless({
      ...this.deps.headlessOptions,
      pty,
      cwd: this.cwd,
      launch,
    })
    this.headless = headless
    this.forwardHeadless(headless, pty)

    // A terminal runtime renders no condition UI of its own. The headless
    // publishes an explicit empty snapshot during start(), which clears any
    // renderer cache left under a stable pane id before recovery/replacement.
    await headless.start()
    // start() yields after publishing initial conditions. A stop, replacement
    // or early PTY exit can win there; identity and idle events from this
    // continuation would otherwise resurrect a backend its owner retired.
    if (generation !== this.startGeneration || this.headless !== headless || this.pty !== pty || this.exited) return

    // The TUI does not expose its session id as a structured startup event.
    // Emit an identity-only transcript envelope through the existing durable
    // identity path: OpenCode's mapper deliberately renders no row for this
    // shape, while its extractor records the id for reload/switch/recovery.
    this.emit('jsonl-entry', { sessionID: providerSessionId }, headless.getTranscriptFile())
    this.emit('process-state', { active: false })
    this.emit('started', {})
  }

  /**
   * Map the package's events onto the AgentSession contract.
   *
   * WHY exit is taken from the headless and not straight from node-pty: when
   * the TUI dies mid-turn the headless first commits what is readable and
   * closes the turn (turn_completed, idle phase, inactive activity, cleared
   * conditions). Forwarding node-pty's exit directly would let SessionManager
   * tear the session down before those closing events arrive, leaving a pane
   * that was busy at the moment of death looking busy in every snapshot taken
   * from its last state.
   */
  private forwardHeadless(headless: OpencodeTerminalHeadless, pty: IPty): void {
    headless.on('activity', ({ active, status }) => {
      this.emit('process-state', status ? { active, status } : { active })
    })
    headless.on('semantic', event => this.emit('semantic-event', event))
    headless.on('entry', record => this.emit('jsonl-entry', record, headless.getTranscriptFile()))
    headless.on('conditions', snapshot => this.emit('conditions', snapshot))
    headless.on('session-switched', ({ to }) => {
      // The package reports the TUI's navigation, but this adapter and its
      // durable reader remain bound to the launch identity (#894). Always
      // name that bound identity: on a second switch the package's `from`
      // names the last TUI screen, not the transcript this pane still reads.
      const from = this.providerSessionId
      this.emit('jsonl-error', Object.assign(new Error(
        `OpenCode switched to session ${to} inside the TUI. This pane still follows ${from}. Resume ${to} from the Resume picker to follow it. (provider_session_switched)`,
      ), { code: 'provider_session_switched' }))
    })
    headless.on('transcript-error', error => {
      // Custom Error properties disappear across IPC; include the category in
      // the message too so the renderer/phone can retain the actual diagnosis.
      this.emit('jsonl-error', Object.assign(new Error(`OpenCode ${error.channel} channel (${error.code}): ${error.message}`), { code: error.code }))
    })
    // This event reports transport health; activity and conditions still come
    // from the live channel and may be stale while disconnected. Durable
    // polling can continue, but it cannot prove the TUI's current busy state.
    headless.on('live-state', state => this.emit('transcript-diagnostic', { kind: 'opencode-terminal-live-state', ...state }))
    headless.on('exit', ({ exitCode, signal }) => {
      // Ignore a stale callback if this wrapper is ever restarted. Production
      // creates a new wrapper per backend generation, but identity fencing here
      // costs nothing and prevents a stopped PTY from retiring a later one in
      // direct tests or future reuse.
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
    })
  }

  write(data: string): void {
    this.pty?.write(data)
  }

  /**
   * WHY programmatic prompts use the TUI's server: first paint plus 250 ms
   * proves neither that the composer mounted nor that it consumed a paste.
   * A booting TUI silently dropped orchestration prompts after we reported
   * success (#877). The package waits for connection/re-sync and submits via
   * prompt_async; only its HTTP acknowledgement completes this capability.
   * The input-readiness grace remains a UI hint and cannot gate delivery.
   */
  async deliverPromptText(text: string): Promise<void> {
    const headless = this.headless
    if (!headless || this.exited) {
      throw new OpencodeTerminalNotReadyError('OpenCode terminal is not running')
    }
    const result = await headless.submitPrompt(text)
    if (result.ok) return
    if (result.reason === 'no-live-channel' || result.reason === 'unreachable') {
      // These failures prove that submission never reached an accepting
      // server. Preserve the existing pre-write marker so orchestration can
      // retain the draft and retry this same pane once its server is ready.
      throw new OpencodeTerminalNotReadyError(result.detail ?? `OpenCode server is not ready (${result.reason})`)
    }
    // A server refusal is not a startup delay. Leave it on the conservative
    // non-retry path rather than repeatedly sending an invalid prompt.
    throw new Error(result.detail ?? 'OpenCode server rejected the prompt')
  }

  /**
   * Answer an OpenCode permission or reject a question through the TUI's own
   * server. The kinds and action names are the structured runtime's, so the
   * Dispatch badge and external condition control treat both runtimes alike.
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
    // HTTP acceptance may arrive after stop/replacement. It describes the old
    // server only; never acknowledge it as a successful action on this backend.
    if (generation !== this.startGeneration || this.headless !== headless || this.exited) {
      return { ok: false, reason: 'cancelled' }
    }
    return result
  }

  resize(cols: number, rows: number): void {
    try {
      this.pty?.resize(cols, rows)
    } catch {
      // Layout transitions can briefly report 0x0; the next xterm FitAddon
      // measurement supplies a valid size, so killing the agent over this
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
    this.importAbort?.abort()
    this.importAbort = null
    this.ptyDataSubscription?.dispose()
    this.ptyDataSubscription = null
    this.exited = true
    this.clearReadinessTimer()
    const headless = this.headless
    this.headless = null
    const pty = this.pty
    this.pty = null
    await headless?.stop()
    try {
      pty?.kill()
    } catch {
      // Idempotent teardown: node-pty throws when the process won the race and
      // exited between the registry lookup and this kill request.
    }
  }

  private clearReadinessTimer(): void {
    if (!this.readinessTimer) return
    clearTimeout(this.readinessTimer)
    this.readinessTimer = null
  }
}
