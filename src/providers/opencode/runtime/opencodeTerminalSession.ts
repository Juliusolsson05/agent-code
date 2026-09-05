import { excludeExternalControlFromOpencode } from '@providers/shared/runtime/externalControlExclusion.js'
import { EventEmitter } from 'events'
import { spawn as ptySpawn } from 'node-pty'
import type { IPty } from 'node-pty'

import { addOpencodeBuiltInMcpLaunchConfig } from '@providers/shared/runtime/builtInMcpLaunch.js'
import { createEmptyOpencodeSession } from './opencodeCliSessions.js'
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
 * Native OpenCode TUI runtime.
 *
 * WHY this is not part of opencode-headless: that package deliberately owns
 * OpenCode's HTTP/SSE `serve` integration and produces structured events. This
 * runtime exists precisely because the native TUI is currently the more mature
 * rendering surface. Keeping the PTY wrapper here lets Agent Code reuse its
 * existing raw-agent terminal attachment while still entering through the same
 * SessionManager path that grants skills, scoped MCP tools, ownership, and
 * lifecycle cleanup.
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

  constructor(options: SessionOptions) {
    super()
    this.cwd = options.cwd
    this.cols = options.cols ?? 120
    this.rows = options.rows ?? 40
    this.binary = options.binary ?? 'opencode'
    this.extraEnv = options.env ?? {}
    this.resumeSessionId = options.resumeSessionId ?? null
    this.dangerousMode = options.dangerousMode === true
    this.builtInMcpServers = options.builtInMcpServers ?? []
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
    const args: string[] = ['--session', providerSessionId]
    // OpenCode calls this flag `--auto`, while Agent Code intentionally exposes
    // one provider-neutral dangerous-mode toggle. Mapping happens here, at the
    // provider boundary, so SessionManager does not learn CLI-specific flags.
    if (this.dangerousMode) args.push('--auto')

    const pty = ptySpawn(this.binary, args, {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      env,
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
    pty.onExit(({ exitCode, signal }) => {
      // Ignore a stale callback if this wrapper is ever restarted. Production
      // creates a new wrapper per backend generation, but identity fencing here
      // costs nothing and prevents a stopped PTY from retiring a later one in
      // direct tests or future reuse.
      if (this.pty !== pty) return
      this.pty = null
      this.exited = true
      this.clearReadinessTimer()
      this.setReady(false)
      this.emit('input-readiness', { ready: false, reason: 'provider-not-ready' })
      this.emit('process-state', { active: false })
      this.emit('exit', { exitCode, signal })
    })

    // A terminal runtime has no app-rendered condition model. Publishing the
    // explicit empty snapshot clears any renderer cache left under a stable
    // pane id before recovery/replacement and keeps the provider identity true.
    this.emit('conditions', { provider: 'opencode', conditions: {}, ts: Date.now() })
    // The TUI does not expose its session id as a structured startup event.
    // Emit an identity-only transcript envelope through the existing durable
    // identity path: OpenCode's mapper deliberately renders no row for this
    // shape, while its extractor records the id for reload/switch/recovery.
    this.emit(
      'jsonl-entry',
      { sessionID: providerSessionId },
      `opencode://session/${providerSessionId}`,
    )
    this.emit('process-state', { active: false })
    this.emit('started', {})
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
    pty.write(`\x1b[200~${text}\x1b[201~\r`)
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
    const pty = this.pty
    this.pty = null
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
