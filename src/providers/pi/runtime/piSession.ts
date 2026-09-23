import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { spawn as ptySpawn } from 'node-pty'
import type { IPty } from 'node-pty'
import {
  PiTerminalHeadless,
  preparePiTerminalLaunch,
  type PiTerminalHeadlessOptions,
} from 'pi-terminal-headless'

import type { AgentSession, AgentSessionEvents, SessionOptions } from '@shared/types/session.js'
import { addPiBuiltInMcpLaunchConfig } from '@providers/shared/runtime/builtInMcpLaunch.js'

/**
 * The bridge never came up, or pi is not running: nothing was sent. The
 * delivery policy maps this code to "retry the same session is safe".
 */
class PiTerminalNotReadyError extends Error {
  readonly code = 'pi-terminal-not-ready'
}

/** pi threw synchronously on the prompt (e.g. a replaced runtime): nothing was queued. */
class PiTerminalRejectedError extends Error {
  readonly code = 'pi-terminal-rejected'
}

/**
 * Injection seams: tests replace the PTY spawn (no real pi) and the launch
 * step (point the package at a replay sandbox). The headless is always the
 * real package, so adapter tests exercise the reader Agent Code ships.
 */
export type PiSessionDeps = {
  spawnPty?: typeof ptySpawn
  prepareLaunch?: typeof preparePiTerminalLaunch
  headlessOptions?: Partial<Omit<PiTerminalHeadlessOptions, 'pty' | 'launch'>>
  /** Absolute path of the bridge extension (resolved by the registry in production). */
  bridgeScriptPath: string
  newSessionId?: () => string
}

/**
 * Native Pi TUI runtime (pi.dev) — Agent Code's terminal-only provider.
 *
 * A thin translator, the job opencodeTerminalSession.ts does for OpenCode: it
 * spawns pi in a PTY (the app owns the process; the package never does) and
 * maps pi-terminal-headless events onto the AgentSession contract. How pi is
 * observed — the session JSONL for committed rows, the bridge extension for
 * activity, turns, dialogs and prompt delivery — lives in that package and
 * docs/decomposition/pi-terminal.md.
 *
 * Identity: a fresh pane mints its session id and launches
 * `pi --session-id <id>`, which creates exactly that session (Stage 0 H1), so
 * unlike OpenCode Terminal there is no CLI round trip before the spawn.
 *
 * Not applicable to Pi, deliberately:
 * - dangerousMode: Pi has no permission system to relax.
 * - project trust: never auto-approved; the bridge surfaces the prompt as an
 *   attention condition and the user answers in the TUI.
 * - external-control exclusion: Pi has no MCP, so no global configuration
 *   can hand it the operator server. Built-in MCP (when enabled) arrives only
 *   through the bridge's own proxy, which lists exactly the servers given.
 */
export interface PiSession {
  on<K extends keyof AgentSessionEvents>(event: K, listener: (...args: AgentSessionEvents[K]) => void): this
  off<K extends keyof AgentSessionEvents>(event: K, listener: (...args: AgentSessionEvents[K]) => void): this
  once<K extends keyof AgentSessionEvents>(event: K, listener: (...args: AgentSessionEvents[K]) => void): this
  emit<K extends keyof AgentSessionEvents>(event: K, ...args: AgentSessionEvents[K]): boolean
}

export class PiSession extends EventEmitter implements AgentSession {
  private pty: IPty | null = null
  private headless: PiTerminalHeadless | null = null
  private exited = false
  private startGeneration = 0
  private providerSessionId: string | null = null
  private ptyDataSubscription: { dispose(): void } | null = null
  /** Monotonic per pane: the shared history-boundary gate ignores a generation it has already seen. */
  private historyGeneration = 0
  private bridgeUnreachableReported = false

  private readonly cwd: string
  private readonly cols: number
  private readonly rows: number
  private readonly binary: string
  private readonly extraEnv: Record<string, string | undefined>
  private readonly resumeSessionId: string | null
  private readonly builtInMcpServers: NonNullable<SessionOptions['builtInMcpServers']>
  private readonly deps: Required<Pick<PiSessionDeps, 'spawnPty' | 'prepareLaunch' | 'newSessionId'>> & Pick<PiSessionDeps, 'headlessOptions' | 'bridgeScriptPath'>

  constructor(options: SessionOptions, deps: PiSessionDeps) {
    super()
    this.cwd = options.cwd
    this.cols = options.cols ?? 120
    this.rows = options.rows ?? 40
    this.binary = options.binary ?? 'pi'
    this.extraEnv = options.env ?? {}
    this.resumeSessionId = options.resumeSessionId ?? null
    this.builtInMcpServers = options.builtInMcpServers ?? []
    this.deps = {
      spawnPty: deps.spawnPty ?? ptySpawn,
      prepareLaunch: deps.prepareLaunch ?? preparePiTerminalLaunch,
      newSessionId: deps.newSessionId ?? randomUUID,
      headlessOptions: deps.headlessOptions,
      bridgeScriptPath: deps.bridgeScriptPath,
    }
  }

  async start(): Promise<void> {
    if (this.pty) throw new Error('PiSession already started')
    const generation = ++this.startGeneration
    this.exited = false
    this.bridgeUnreachableReported = false
    this.emit('input-readiness', { ready: false, reason: 'starting' })

    // The complete inherited environment (a GUI-launched app still needs PATH,
    // HOME and provider credentials); caller overrides win, undefined removes.
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) if (typeof value === 'string') env[key] = value
    env.TERM = 'xterm-256color'
    env.COLORTERM = 'truecolor'
    // An agent pane is not the place for Pi's "new version available" nag;
    // the upstream-watch workflow tracks versions for Agent Code instead.
    env.PI_SKIP_VERSION_CHECK = '1'
    for (const [key, value] of Object.entries(this.extraEnv)) {
      if (value === undefined) delete env[key]
      else env[key] = value
    }
    // After the caller's overrides: these endpoints and their token were
    // minted for exactly this session, and nothing may shadow them.
    addPiBuiltInMcpLaunchConfig(this.builtInMcpServers, env)

    const providerSessionId = this.resumeSessionId ?? this.deps.newSessionId()
    this.providerSessionId = providerSessionId
    const launch = await this.deps.prepareLaunch({ binary: this.binary, cwd: this.cwd, env, sessionId: providerSessionId, bridgeScriptPath: this.deps.bridgeScriptPath })
    if (generation !== this.startGeneration) {
      await launch.dispose()
      return
    }

    // WHY dispose here: until the headless is constructed, nothing else owns
    // the prepared launch (its temp dir holds the bridge script and socket).
    // A spawn that throws (the binary vanished after resolution, EACCES)
    // leaves this.headless null, so stop() cannot reach it and the
    // `acpi-*` directory would outlive the pane (Astra review, finding 4).
    let pty: IPty
    try {
      pty = this.deps.spawnPty(launch.binary, launch.args, { name: 'xterm-256color', cols: this.cols, rows: this.rows, cwd: this.cwd, env: launch.env })
    } catch (error) {
      await launch.dispose()
      throw error
    }
    this.pty = pty
    this.ptyDataSubscription = pty.onData(data => {
      if (generation !== this.startGeneration || this.pty !== pty || this.exited) return
      // SessionManager's capped replay buffer attaches the visible terminal,
      // including output that arrived before React mounted.
      this.emit('pty-data', data)
    })

    const headless = new PiTerminalHeadless({ ...this.deps.headlessOptions, pty, launch })
    this.headless = headless
    this.forwardHeadless(headless, pty)
    await headless.start()
    if (generation !== this.startGeneration || this.headless !== headless || this.pty !== pty || this.exited) return

    // Identity before the file exists: a fresh pi writes nothing until its
    // first reply completes (Stage 0 H1), and a resumed session's history is
    // loaded by the host, not re-emitted. This identity-only envelope is what
    // lets the renderer bind the pane to its provider session immediately
    // (the Pi mapper renders no row for it). The file argument is '' while a
    // fresh session's file does not exist yet: SessionManager treats a falsy
    // observed path as "not known" and falls back to resolving it, instead of
    // publishing a directory as the transcript.
    this.emit('jsonl-entry', { type: 'agent-code-identity', sessionId: providerSessionId }, headless.getTranscriptFile() ?? '')
    this.emit('process-state', { active: false })
    this.emit('started', {})
  }

  /**
   * Map the package's events onto the AgentSession contract.
   *
   * WHY exit is taken from the headless, not straight from node-pty: when pi
   * dies mid-turn the headless first drains the file and closes the turn;
   * forwarding node-pty's exit directly would let SessionManager tear the
   * pane down before those closing events arrive.
   */
  private forwardHeadless(headless: PiTerminalHeadless, pty: IPty): void {
    headless.on('activity', ({ active, status }) => {
      // Unknown (no bridge) is reported as not-active with its status, never
      // as busy: a fabricated "working" pane blocks close/switch guards.
      this.emit('process-state', { active: active === true, status })
    })
    headless.on('semantic', event => this.emit('semantic-event', event))
    headless.on('entry', ({ row, file }) => this.emit('jsonl-entry', row, file))
    headless.on('history', ({ kind, file }) => {
      if (kind === 'reset') this.historyGeneration += 1
      this.emit('history-boundary', { type: kind, generation: this.historyGeneration, snapshotByteLength: 0, file })
    })
    headless.on('conditions', snapshot => {
      // The package builds its snapshot on the vendored conditions core with
      // provider 'pi', the same shape as every provider's.
      this.emit('conditions', snapshot as unknown as AgentSessionEvents['conditions'][0])
    })
    headless.on('session-switched', ({ to, reason }) => {
      // Following pi (decision D4): /new, /resume, /fork move this pane to the
      // session pi now writes. The package has already retargeted its reader
      // and emits a history reset + the new branch; the identity change must
      // reach the pane too, or reload/resume/copy-resume would still point at
      // the old session.
      this.providerSessionId = to.sessionId
      this.emit('provider-session-changed', { providerSessionId: to.sessionId, transcriptFile: to.file, reason })
    })
    headless.on('transcript-error', error => {
      if (error.channel === 'durable') {
        // Electron drops custom Error properties across IPC; the code rides in the message too.
        this.emit('jsonl-error', Object.assign(new Error(`Pi session file (${error.code}): ${error.message}`), { code: error.code }))
        return
      }
      // Live-channel faults (a refused peer, a turn that ended before its
      // rows were readable) are diagnostics, not transcript failures: the
      // durable channel still carries the conversation.
      this.emit('transcript-diagnostic', { kind: 'pi-terminal-live-error', ...error })
    })
    headless.on('live-state', state => {
      this.emit('transcript-diagnostic', { kind: 'pi-terminal-live-state', ...state })
      // Programmatic delivery goes through the bridge, so it is exactly what
      // gates readiness; a human can always type into the TUI regardless.
      this.emit('input-readiness', state.connected ? { ready: true, reason: 'ready' } : { ready: false, reason: 'provider-not-ready' })
      if (state.connected || state.reason !== 'bridge-unreachable' || this.bridgeUnreachableReported) return
      this.bridgeUnreachableReported = true
      this.emit('jsonl-error', Object.assign(new Error(
        'Pi started, but Agent Code\'s bridge extension never connected, so this pane cannot show whether Pi is working or deliver prompts. ' +
        'The conversation still appears as Pi saves it. Reload this agent to retry; if it keeps happening, check that your pi version is supported. (provider_bridge_unreachable)',
      ), { code: 'provider_bridge_unreachable' }))
    })
    headless.on('exit', ({ exitCode, signal }) => {
      if (this.pty !== pty) return
      this.pty = null
      this.headless = null
      this.exited = true
      this.ptyDataSubscription?.dispose()
      this.ptyDataSubscription = null
      this.emit('input-readiness', { ready: false, reason: 'provider-not-ready' })
      this.emit('process-state', { active: false })
      this.emit('exit', { exitCode, signal })
    })
  }

  write(data: string): void {
    this.pty?.write(data)
  }

  /**
   * Programmatic prompts go through the bridge (pi.sendUserMessage, always as
   * followUp), acknowledged only by Pi's own evidence. Pasting into the TUI is
   * never used for delivery: a paste into a TUI that is not listening is lost
   * and nobody can tell (#877).
   */
  async deliverPromptText(text: string): Promise<void> {
    const headless = this.headless
    if (!headless || this.exited) throw new PiTerminalNotReadyError('pi is not running')
    const result = await headless.submitPrompt(text)
    if (result.ok) return
    if (result.reason === 'no-live-channel') throw new PiTerminalNotReadyError(result.message ?? 'the Pi bridge is not connected')
    if (result.reason === 'rejected') throw new PiTerminalRejectedError(result.message ?? 'pi refused the prompt')
    // unknown: it may still run; the generic error means "possibly written, do not retry".
    throw new Error(result.message ?? 'pi prompt delivery outcome is unknown')
  }

  resize(cols: number, rows: number): void {
    try {
      this.pty?.resize(cols, rows)
    } catch {
      // A 0x0 layout frame; the next fit measurement corrects it.
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
    this.ptyDataSubscription?.dispose()
    this.ptyDataSubscription = null
    this.exited = true
    const headless = this.headless
    this.headless = null
    const pty = this.pty
    this.pty = null
    await headless?.stop()
    try {
      pty?.kill()
    } catch {
      // Idempotent: pi may have exited between lookup and kill.
    }
  }
}
