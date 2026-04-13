import { EventEmitter } from 'events'
import { spawn as ptySpawn } from 'node-pty'

import type { SlashPickerState } from '../../../preload/index.js'
import {
  ClaudeCodeHeadless,
  terminalToMarkdown,
  type CompactionState,
  type JsonlEntry,
  type ResumePromptState,
  type TrustDialogState,
} from 'claude-code-headless'

// Re-export terminalToMarkdown so existing callers keep working.
export { terminalToMarkdown }

export type ClaudeSessionOptions = {
  cwd?: string
  cols?: number
  rows?: number
  binary?: string
  env?: Record<string, string | undefined>
  snapshotIntervalMs?: number
  resumeSessionId?: string
}

export type ScreenSnapshot = {
  plain: string
  markdown: string
  picker: SlashPickerState
}

export type ClaudeSessionEvents = {
  started: [{ projectDir: string }]
  'pty-data': [string]
  screen: [ScreenSnapshot]
  'jsonl-entry': [JsonlEntry, string]
  'jsonl-error': [Error]
  'process-state': [{ active: boolean }]
  'trust-dialog': [TrustDialogState]
  'resume-prompt': [ResumePromptState]
  'compaction-state': [CompactionState]
  exit: [{ exitCode: number; signal?: number }]
}

export interface ClaudeSession {
  on<K extends keyof ClaudeSessionEvents>(
    event: K,
    listener: (...args: ClaudeSessionEvents[K]) => void,
  ): this
  off<K extends keyof ClaudeSessionEvents>(
    event: K,
    listener: (...args: ClaudeSessionEvents[K]) => void,
  ): this
  emit<K extends keyof ClaudeSessionEvents>(
    event: K,
    ...args: ClaudeSessionEvents[K]
  ): boolean
}

export class ClaudeSession extends EventEmitter {
  private headless: ClaudeCodeHeadless | null = null
  private pty: ReturnType<typeof ptySpawn> | null = null
  private picker: SlashPickerState = { visible: false, items: [] }
  private exited = false

  private readonly cwd: string
  private readonly cols: number
  private readonly rows: number
  private readonly binary: string
  private readonly env: Record<string, string | undefined>
  private readonly snapshotIntervalMs: number
  private readonly resumeSessionId: string | null

  constructor(options: ClaudeSessionOptions = {}) {
    super()
    this.cwd = options.cwd ?? process.cwd()
    this.cols = options.cols ?? 120
    this.rows = options.rows ?? 40
    this.binary = options.binary ?? 'claude'
    this.resumeSessionId = options.resumeSessionId ?? null
    this.snapshotIntervalMs = options.snapshotIntervalMs ?? 16

    const env: Record<string, string | undefined> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === 'string') env[k] = v
    }
    env.TERM = 'xterm-256color'
    env.COLORTERM = 'truecolor'
    env.CLAUDE_CODE_ENTRYPOINT = 'claude-desktop'
    for (const [k, v] of Object.entries(options.env ?? {})) {
      if (v === undefined) delete env[k]
      else env[k] = v
    }
    this.env = env
  }

  async start(): Promise<void> {
    const args: string[] = []
    if (this.resumeSessionId) args.push('--resume', this.resumeSessionId)

    const cleanEnv: Record<string, string> = {}
    for (const [k, v] of Object.entries(this.env)) {
      if (typeof v === 'string') cleanEnv[k] = v
    }

    this.pty = ptySpawn(this.binary, args, {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      env: cleanEnv,
    })

    this.headless = new ClaudeCodeHeadless({
      pty: this.pty,
      cwd: this.cwd,
      cols: this.cols,
      rows: this.rows,
      snapshotIntervalMs: this.snapshotIntervalMs,
      resumeSessionId: this.resumeSessionId ?? undefined,
    })

    this.pty.onData((data: string) => this.emit('pty-data', data))

    this.headless.on('slash-picker', picker => {
      this.picker = picker
    })

    this.headless.on('screen', snap => {
      this.emit('screen', {
        plain: snap.plain,
        markdown: snap.markdown,
        picker: this.headless?.getSlashPickerState() ?? this.picker,
      })
    })

    this.headless.on('jsonl-entry', (entry, file) =>
      this.emit('jsonl-entry', entry, file),
    )
    this.headless.on('jsonl-error', err =>
      this.emit('jsonl-error', err),
    )
    this.headless.on('process-state', state =>
      this.emit('process-state', state),
    )
    this.headless.on('trust-dialog', state =>
      this.emit('trust-dialog', state),
    )
    this.headless.on('resume-prompt', state =>
      this.emit('resume-prompt', state),
    )
    this.headless.on('compaction-state', state =>
      this.emit('compaction-state', state),
    )
    this.headless.on('exit', ({ exitCode, signal }) => {
      this.exited = true
      this.emit('exit', { exitCode, signal })
    })

    const { projectDir } = await this.headless.start()
    this.emit('started', { projectDir })
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
