import { EventEmitter } from 'events'
import { spawn as ptySpawn } from 'node-pty'

import type { SlashPickerState } from '../../../preload/index.js'
import {
  CodexHeadless,
  type CodexRolloutLine,
} from 'codex-headless'

// CodexSession — thin wrapper that spawns the `codex` binary in a PTY
// and delegates all screen parsing, transcript tailing, trust dialog
// detection, and activity tracking to the codex-headless package.
//
// This class owns the PTY lifecycle (spawn + kill). It passes the PTY
// to CodexHeadless which does all the headless terminal + parser work.
// Events are forwarded with sessionId-compatible shapes so
// SessionManager can treat Claude and Codex sessions uniformly.
//
// Why this wrapper exists at all (instead of using CodexHeadless directly):
//   - cc-shell needs to SPAWN the process (CodexHeadless takes an IPty)
//   - cc-shell needs the SlashPickerState shape for IPC compatibility
//   - The event shapes must match ClaudeSession's for SessionManager

export type CodexSessionOptions = {
  cwd?: string
  cols?: number
  rows?: number
  binary?: string
  env?: Record<string, string | undefined>
  snapshotIntervalMs?: number
  resumeSessionId?: string
}

export type CodexScreenSnapshot = {
  plain: string
  markdown: string
  picker: SlashPickerState
}

export type CodexSessionEvents = {
  started: [{ projectDir: string }]
  'pty-data': [string]
  screen: [CodexScreenSnapshot]
  'jsonl-entry': [CodexRolloutLine, string]
  'jsonl-error': [Error]
  exit: [{ exitCode: number; signal?: number }]
}

export interface CodexSession {
  on<K extends keyof CodexSessionEvents>(
    event: K,
    listener: (...args: CodexSessionEvents[K]) => void,
  ): this
  off<K extends keyof CodexSessionEvents>(
    event: K,
    listener: (...args: CodexSessionEvents[K]) => void,
  ): this
  emit<K extends keyof CodexSessionEvents>(
    event: K,
    ...args: CodexSessionEvents[K]
  ): boolean
}

export class CodexSession extends EventEmitter {
  private headless: CodexHeadless | null = null
  private pty: ReturnType<typeof ptySpawn> | null = null
  private exited = false

  private readonly cwd: string
  private readonly cols: number
  private readonly rows: number
  private readonly binary: string
  private readonly env: Record<string, string | undefined>
  private readonly snapshotIntervalMs: number
  private readonly resumeSessionId: string | null

  constructor(options: CodexSessionOptions = {}) {
    super()
    this.cwd = options.cwd ?? process.cwd()
    this.cols = options.cols ?? 120
    this.rows = options.rows ?? 40
    this.binary = options.binary ?? 'codex'
    this.resumeSessionId = options.resumeSessionId ?? null
    this.snapshotIntervalMs = options.snapshotIntervalMs ?? 16

    // Build env: start from process.env so PATH, HOME, API keys
    // propagate. Force TERM + COLORTERM for proper color output.
    const env: Record<string, string | undefined> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === 'string') env[k] = v
    }
    env.TERM = 'xterm-256color'
    env.COLORTERM = 'truecolor'
    for (const [k, v] of Object.entries(options.env ?? {})) {
      if (v === undefined) delete env[k]
      else env[k] = v
    }
    this.env = env
  }

  async start(): Promise<void> {
    // Codex uses a subcommand for resume: `codex resume <id>`.
    const args: string[] = []
    if (this.resumeSessionId) {
      args.push('resume', this.resumeSessionId)
    }

    // Filter undefined env entries — node-pty expects strings only.
    const cleanEnv: Record<string, string> = {}
    for (const [k, v] of Object.entries(this.env)) {
      if (typeof v === 'string') cleanEnv[k] = v
    }

    // Spawn the PTY.
    this.pty = ptySpawn(this.binary, args, {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      env: cleanEnv,
    })

    // Create CodexHeadless — it attaches to the PTY and does all
    // the headless terminal + parser + transcript work.
    this.headless = new CodexHeadless({
      pty: this.pty,
      cwd: this.cwd,
      cols: this.cols,
      rows: this.rows,
      snapshotIntervalMs: this.snapshotIntervalMs,
      resumeThreadId: this.resumeSessionId ?? undefined,
    })

    // Forward raw PTY bytes — SessionManager expects this event.
    this.pty.onData((data: string) => {
      this.emit('pty-data', data)
    })

    // Forward screen snapshots.
    this.headless.on('screen', snap => {
      this.emit('screen', {
        plain: snap.plain,
        markdown: snap.markdown,
        // Codex doesn't have a slash picker yet — static "not visible"
        // so the renderer's picker component stays hidden.
        picker: { visible: false, items: [] },
      })
    })

    // Forward rollout entries as jsonl-entry (matches Claude's event name).
    this.headless.on('rollout-entry', (line, file) => {
      this.emit('jsonl-entry', line as unknown as CodexRolloutLine, file)
    })

    this.headless.on('rollout-error', err => {
      this.emit('jsonl-error', err)
    })

    this.headless.on('exit', ({ exitCode, signal }) => {
      this.exited = true
      this.emit('exit', { exitCode, signal })
    })

    // Start the transcript tailer BEFORE we emit started — same
    // ordering as ClaudeSession to avoid missing early entries.
    const { sessionsDir } = await this.headless.start()
    this.emit('started', { projectDir: sessionsDir })
  }

  write(data: string): void {
    this.headless?.write(data)
  }

  resize(cols: number, rows: number): void {
    this.headless?.resize(cols, rows)
  }

  snapshotScreen(): string {
    return this.headless?.getScreen() ?? ''
  }

  snapshotScreenAsMarkdown(): string {
    return this.headless?.getScreenMarkdown() ?? ''
  }

  isExited(): boolean {
    return this.exited
  }

  async stop(): Promise<void> {
    await this.headless?.stop()
    try { this.pty?.kill() } catch { /* already gone */ }
    this.pty = null
  }
}
