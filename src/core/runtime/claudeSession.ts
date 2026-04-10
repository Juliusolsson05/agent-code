import { EventEmitter } from 'events'
import { spawn as ptySpawn, type IPty } from 'node-pty'
// @xterm/headless is published as CommonJS; Node's ESM interop can't see its
// named exports, so we import the default and destructure.
import xtermHeadless from '@xterm/headless'

import { getProjectDirForCwd } from './projectDir.js'
import { tailNewSessionFile, type JsonlEntry } from './jsonlTailer.js'

const { Terminal } = xtermHeadless

// Lives under src/core/runtime/ — Node-only. Used by the Electron main
// process AND the standalone testbench AND the future dispatch-mode
// runner. Has NO knowledge of Electron, IPC, React, or the DOM.
//
// The session class owns:
//   - the PTY child process (`claude` running interactively)
//   - the headless terminal that parses CC's ANSI output
//   - the JSONL file watcher for the session's transcript
//
// It emits events. Hosts (electron / testbench / etc.) subscribe.

export type ClaudeSessionOptions = {
  /** Working directory CC will run in. Defaults to process.cwd(). */
  cwd?: string
  /** Terminal columns. Default 120. */
  cols?: number
  /** Terminal rows. Default 40. */
  rows?: number
  /** Path / name of the claude binary. Default `'claude'` (PATH lookup). */
  binary?: string
  /** Extra environment variables for the spawned CC process. */
  env?: Record<string, string | undefined>
  /**
   * Throttle interval in ms for emitting `screen` events. CC's Ink redraws
   * very frequently and we don't want to flood subscribers. Default 16
   * (~60 Hz). Set to 0 to emit on every PTY chunk.
   */
  snapshotIntervalMs?: number
}

/**
 * The events emitted by a ClaudeSession. Subscribe via `.on('eventName', cb)`.
 *
 *   started        — PTY spawned successfully; payload is the absolute path
 *                    of the CC project dir we're tailing for JSONL entries
 *   pty-data       — raw bytes received from the PTY (string); use this for
 *                    full fidelity recording in the testbench
 *   screen         — throttled snapshot of the headless terminal buffer as
 *                    plain text (no colors yet); use this for the live
 *                    streaming preview in the renderer
 *   jsonl-entry    — a parsed JSONL entry from CC's transcript file
 *   jsonl-error    — non-fatal parse / tail error from the jsonl tailer
 *   exit           — the PTY child exited; payload is { exitCode, signal? }
 *
 * Listeners can be added before or after `start()`. Events are buffered
 * naturally by Node's EventEmitter — but if you attach AFTER start() you
 * may miss the very first frames.
 */
export type ClaudeSessionEvents = {
  started: [{ projectDir: string }]
  'pty-data': [string]
  screen: [string]
  'jsonl-entry': [JsonlEntry, string]
  'jsonl-error': [Error]
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
  private pty: IPty | null = null
  private term: InstanceType<typeof Terminal> | null = null
  private stopJsonlTail: (() => Promise<void>) | null = null
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private flushPending = false
  private exited = false

  private readonly cwd: string
  private readonly cols: number
  private readonly rows: number
  private readonly binary: string
  private readonly extraEnv: Record<string, string | undefined>
  private readonly snapshotIntervalMs: number

  constructor(options: ClaudeSessionOptions = {}) {
    super()
    this.cwd = options.cwd ?? process.cwd()
    this.cols = options.cols ?? 120
    this.rows = options.rows ?? 40
    this.binary = options.binary ?? 'claude'
    this.extraEnv = options.env ?? {}
    this.snapshotIntervalMs = options.snapshotIntervalMs ?? 16
  }

  /**
   * Resolve the JSONL project dir, attach the watcher BEFORE spawning so we
   * don't miss the file-creation event, then spawn `claude` in a PTY.
   * Resolves once the PTY has been created. Use `on('exit')` to know when
   * the child terminates.
   */
  async start(): Promise<void> {
    if (this.pty) throw new Error('ClaudeSession already started')

    this.term = new Terminal({
      cols: this.cols,
      rows: this.rows,
      allowProposedApi: true,
      scrollback: 10000,
    })

    const projectDir = await getProjectDirForCwd(this.cwd)
    this.stopJsonlTail = await tailNewSessionFile(
      projectDir,
      (entry, file) => this.emit('jsonl-entry', entry, file),
      err => this.emit('jsonl-error', err),
    )

    const env: Record<string, string> = {}
    // Start with current process env so PATH, HOME etc. propagate.
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === 'string') env[k] = v
    }
    // Force a true-color xterm so Ink renders cleanly.
    env.TERM = 'xterm-256color'
    env.COLORTERM = 'truecolor'
    // Tell CC it's running inside a desktop wrapper. Matches main.tsx:825
    // of claude-code-src — `clientType === 'claude-desktop'` branch.
    env.CLAUDE_CODE_ENTRYPOINT = 'claude-desktop'
    // Apply caller overrides last so they win.
    for (const [k, v] of Object.entries(this.extraEnv)) {
      if (v === undefined) delete env[k]
      else env[k] = v
    }

    this.pty = ptySpawn(this.binary, [], {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      env,
    })

    this.pty.onData((data: string) => {
      this.emit('pty-data', data)
      this.term?.write(data)
      this.scheduleFlush()
    })

    this.pty.onExit(({ exitCode, signal }) => {
      this.exited = true
      this.emit('exit', { exitCode, signal })
      void this.cleanup()
    })

    this.emit('started', { projectDir })
  }

  /** Write raw bytes to the PTY. Used for keystroke synthesis. */
  write(data: string): void {
    this.pty?.write(data)
  }

  /** Resize both the PTY and the headless terminal in lockstep. */
  resize(cols: number, rows: number): void {
    this.pty?.resize(cols, rows)
    this.term?.resize(cols, rows)
  }

  /**
   * Capture the headless terminal's current visible buffer as plain text.
   * Synchronous — call any time after `start()`.
   */
  snapshotScreen(): string {
    if (!this.term) return ''
    const buf = this.term.buffer.active
    const lines: string[] = []
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i)
      lines.push(line ? line.translateToString(true) : '')
    }
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    return lines.join('\n')
  }

  /** True if the PTY has exited. */
  isExited(): boolean {
    return this.exited
  }

  /** Stop the session: kill the PTY, close the JSONL watcher. Idempotent. */
  async stop(): Promise<void> {
    try {
      this.pty?.kill()
    } catch {
      // already gone
    }
    this.pty = null
    await this.cleanup()
  }

  // ---------------------------------------------------------------------------

  private scheduleFlush(): void {
    if (this.flushPending) return
    this.flushPending = true
    this.flushTimer = setTimeout(() => {
      this.flushPending = false
      this.flushTimer = null
      this.emit('screen', this.snapshotScreen())
    }, this.snapshotIntervalMs)
  }

  private async cleanup(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.flushPending = false
    if (this.stopJsonlTail) {
      try {
        await this.stopJsonlTail()
      } catch {
        // best-effort
      }
      this.stopJsonlTail = null
    }
  }
}
