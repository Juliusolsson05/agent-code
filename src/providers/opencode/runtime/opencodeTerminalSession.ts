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
const PROMPT_READY_TIMEOUT_MS = 15_000

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
 * - composer readiness (first paint + grace) and bracketed-paste delivery
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
  private providerSessionId: string | null = null
  private readinessPromise: Promise<boolean> | null = null
  private resolveReadiness: ((ready: boolean) => void) | null = null
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
    this.readinessPromise = new Promise(resolve => {
      this.resolveReadiness = resolve
    })
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

    const providerSessionId = this.resumeSessionId ?? await createEmptyOpencodeSession({
      binary: this.binary,
      cwd: this.cwd,
      env,
    })
    if (generation !== this.startGeneration) {
      // stop() may win while the CLI import is still running. The import is a
      // short-lived child we cannot cancel through node-pty, but the generation
      // fence prevents it from materializing a TUI after SessionManager has
      // already released ownership of this wrapper.
      return
    }
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

    pty.onData(data => {
      // SessionManager already owns a capped attach/replay buffer for agent PTY
      // bytes. Forwarding the native stream through that channel is what makes
      // a TUI launched before React mounts appear complete instead of blank.
      this.emit('pty-data', data)
      if (!this.readinessTimer) {
        // Native OpenCode does not publish a machine-readable "composer ready"
        // event. First output proves the process reached its terminal UI; one
        // short fixed grace lets the initial layout and key handlers mount.
        // This is deliberately NOT a quiet-period debounce: animated spinners
        // can redraw forever and would make an otherwise usable TUI permanently
        // reject MCP/linked-agent prompt delivery.
        this.readinessTimer = setTimeout(() => {
          this.readinessTimer = null
          if (generation !== this.startGeneration || this.pty !== pty || this.exited) return
          this.setReady(true)
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
    headless.on('transcript-error', error => {
      this.emit('jsonl-error', Object.assign(new Error(`OpenCode ${error.channel} channel: ${error.message}`), { code: error.code }))
    })
    // Live-channel health is diagnostic, never a correctness input: the pane
    // keeps working on the durable channel while the server is unreachable.
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
      this.clearReadinessTimer()
      this.setReady(false)
      this.emit('input-readiness', { ready: false, reason: 'provider-not-ready' })
      this.emit('process-state', { active: false })
      this.emit('exit', { exitCode, signal })
    })
  }

  write(data: string): void {
    this.pty?.write(data)
  }

  /**
   * Keep provider-owned prompt delivery usable for orchestration callers.
   *
   * WHY bracketed paste is one PTY write: OpenCode's TUI can distinguish a
   * pasted multi-line prompt from command keystrokes, and keeping paste plus
   * Enter atomic prevents another renderer input from interleaving between the
   * content and submission boundary. Unlike the HTTP runtime, acceptance here
   * means transport write, not a durable transcript acknowledgement.
   */
  async deliverPromptText(text: string): Promise<void> {
    const readiness = this.readinessPromise
    if (!readiness) throw new Error('OpenCode terminal is not running')
    const ready = await new Promise<boolean>(resolve => {
      let timeout: ReturnType<typeof setTimeout> | null = null
      let settled = false
      const finish = (value: boolean) => {
        if (settled) return
        settled = true
        if (timeout) clearTimeout(timeout)
        resolve(value)
      }
      void readiness.then(finish)
      timeout = setTimeout(() => finish(false), PROMPT_READY_TIMEOUT_MS)
    })
    const pty = this.pty
    if (!ready || !pty || this.exited) {
      // The provider delivery policy distinguishes this proven pre-write
      // refusal from a PTY write that may have crossed the process boundary.
      // Without a stable marker it must conservatively label every throw as
      // do-not-retry, stranding orchestration on a harmless startup timeout.
      throw new OpencodeTerminalNotReadyError(
        'OpenCode terminal did not become ready for prompt input',
      )
    }
    if (this.headless) this.headless.pasteAndSubmit(text)
    else pty.write(`\x1b[200~${text}\x1b[201~\r`)
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
    return await headless.resolveConditionAction(action)
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

  getProviderSessionId(): string | null {
    return this.providerSessionId
  }

  async stop(): Promise<void> {
    this.startGeneration += 1
    this.exited = true
    this.clearReadinessTimer()
    this.setReady(false)
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

  private setReady(ready: boolean): void {
    const resolve = this.resolveReadiness
    this.resolveReadiness = null
    resolve?.(ready)
  }

  private clearReadinessTimer(): void {
    if (!this.readinessTimer) return
    clearTimeout(this.readinessTimer)
    this.readinessTimer = null
  }
}
