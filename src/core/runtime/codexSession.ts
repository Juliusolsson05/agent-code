import { EventEmitter } from 'events'
import { createWriteStream, mkdirSync, type WriteStream } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { extractCodexAssistantInProgress } from '../parsers/codex/streamingScreen.js'
import type { SlashPickerState } from '../parsers/claude/slashCommandPicker.js'
import type { JsonlEntry } from './jsonlTailer.js'
import { getCodexSessionsDir } from './codexProjectDir.js'
import { PtyScreen } from './ptyScreen.js'

// CodexSession — OpenAI Codex agent session.
//
// Counterpart to ClaudeSession. Both compose a PtyScreen internally
// for the PTY + headless xterm + dual snapshot plumbing; the
// provider-specific differences are:
//
//   Binary:  `codex` (not `claude`)
//   Resume:  `codex resume <id>` (subcommand, not --resume flag)
//   Env:     no CLAUDE_CODE_ENTRYPOINT — codex doesn't need it
//   JSONL:   ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
//            (date-bucketed, not per-cwd)
//   Screen:  no slash-picker enrichment yet (will add later when
//            we build a codex-specific picker detector)
//
// The public event shape intentionally matches ClaudeSession so
// SessionManager can treat both uniformly — same `started`,
// `pty-data`, `screen`, `jsonl-entry`, `jsonl-error`, `exit` events.
// This means SessionManager's event-wiring code works for both
// without any kind-specific branches.
//
// V1 simplification: we do NOT tail the codex rollout file yet.
// The screen scrape is the primary data source for the streaming
// card, and the feed can start empty. Once we have a working live
// pane and real recordings, we'll add JSONL tailing by watching
// the codex sessions directory for new rollout-*.jsonl files (same
// pattern as Claude's tailNewSessionFile but pointed at a different
// directory and with a different filename glob).

export type CodexSessionOptions = {
  /** Working directory codex will run in. Defaults to process.cwd(). */
  cwd?: string
  /** Terminal columns. Default 120. */
  cols?: number
  /** Terminal rows. Default 40. */
  rows?: number
  /** Path / name of the codex binary. Default `'codex'` (PATH lookup). */
  binary?: string
  /** Extra environment variables for the spawned process. */
  env?: Record<string, string | undefined>
  /** Throttle interval in ms for emitting `screen` events. Default 16. */
  snapshotIntervalMs?: number
  /**
   * If set, spawn `codex resume <id>` to reopen an existing session.
   * Codex uses a subcommand for resume, not a flag like Claude.
   */
  resumeSessionId?: string
}

/**
 * Same event shape as ClaudeSession so SessionManager can be
 * provider-agnostic in its event wiring.
 */
export type CodexScreenSnapshot = {
  plain: string
  markdown: string
  // Codex doesn't have a slash picker detector yet — ship a static
  // "not visible" so the renderer's picker component stays hidden.
  picker: SlashPickerState
}

export type CodexSessionEvents = {
  started: [{ projectDir: string }]
  'pty-data': [string]
  screen: [CodexScreenSnapshot]
  'jsonl-entry': [JsonlEntry, string]
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
  private readonly ptyScreen: PtyScreen
  private exited = false
  private readonly cwd: string
  // Debug log — writes every screen snapshot + extract to a file
  // so we can diagnose "thinking forever" bugs in the live app.
  // Written to /tmp/cc-shell-codex-debug-<ts>.log.
  private debugLog: WriteStream | null = null
  private debugSnapCount = 0

  constructor(options: CodexSessionOptions = {}) {
    super()
    this.cwd = options.cwd ?? process.cwd()

    // Open a debug log for this session.
    try {
      const debugDir = join(tmpdir(), 'cc-shell-debug')
      mkdirSync(debugDir, { recursive: true })
      const ts = new Date().toISOString().replace(/[:.]/g, '-')
      this.debugLog = createWriteStream(
        join(debugDir, `codex-${ts}.log`),
        { flags: 'a' },
      )
      this.debugLog.write(`[codex-debug] session started at ${ts}\n`)
      this.debugLog.write(`[codex-debug] cwd: ${this.cwd}\n`)
    } catch {
      // Debug logging is best-effort; don't break the session.
    }

    // Build the env. Start from process.env so PATH etc. propagate.
    // Force TERM + COLORTERM for proper color output. No
    // CLAUDE_CODE_ENTRYPOINT — that's Claude-specific.
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

    // Codex uses a subcommand for resume: `codex resume <id>`.
    // For a fresh session we just run `codex` with no args.
    const args: string[] = []
    if (options.resumeSessionId) {
      args.push('resume', options.resumeSessionId)
    }

    this.ptyScreen = new PtyScreen({
      binary: options.binary ?? 'codex',
      args,
      cwd: this.cwd,
      cols: options.cols ?? 120,
      rows: options.rows ?? 40,
      env,
      snapshotIntervalMs: options.snapshotIntervalMs ?? 16,
    })

    // Forward PTY bytes + debug log.
    this.ptyScreen.on('pty-data', data => {
      if (this.debugLog) {
        this.debugLog.write(`[pty-data] len=${data.length}\n`)
      }
      this.emit('pty-data', data)
    })

    // Emit screen snapshots. No slash-picker enrichment yet —
    // just pass through the base snapshot with a static "not visible"
    // picker so the renderer's picker component stays hidden.
    this.ptyScreen.on('screen', base => {
      // Debug: log every Nth snapshot + the parser extract so we can
      // diagnose streaming-card issues from a live app session.
      this.debugSnapCount++
      if (this.debugLog) {
        const extract = extractCodexAssistantInProgress(base.plain)
        this.debugLog.write(
          `[snap ${this.debugSnapCount}] extract=${JSON.stringify(extract.slice(0, 120))} plainLen=${base.plain.length}\n`,
        )
        // Dump full screen frequently — every 10th snap — so we
        // can see exactly what the headless xterm buffer contains
        // during the "thinking forever" window.
        if (this.debugSnapCount % 10 === 1) {
          this.debugLog.write(
            `--- FULL SCREEN (snap ${this.debugSnapCount}) ---\n${base.plain}\n--- END ---\n`,
          )
        }
      }

      this.emit('screen', {
        plain: base.plain,
        markdown: base.markdown,
        picker: { visible: false, items: [] },
      })
    })

    this.ptyScreen.on('exit', ({ exitCode, signal }) => {
      this.exited = true
      this.emit('exit', { exitCode, signal })
    })
  }

  /**
   * Spawn the codex binary. The JSONL tailer is NOT wired yet (v1
   * simplification — see the block comment at the top of this file).
   * The streaming card works via screen scrape alone.
   */
  async start(): Promise<void> {
    // Emit the sessions dir as the "project dir" so the renderer
    // has a path to show in the pane header. For Claude this is
    // per-cwd; for codex it's the global sessions root.
    const projectDir = getCodexSessionsDir()
    await this.ptyScreen.start()
    this.emit('started', { projectDir })
  }

  write(data: string): void {
    // Debug: log every write so we can verify keystrokes reach the PTY.
    if (this.debugLog) {
      const preview = data.replace(/\r/g, '⏎').replace(/\n/g, '⏎').slice(0, 60)
      this.debugLog.write(`[write] ${JSON.stringify(preview)}\n`)
    }
    this.ptyScreen.write(data)
  }

  resize(cols: number, rows: number): void {
    this.ptyScreen.resize(cols, rows)
  }

  snapshotScreen(): string {
    return this.ptyScreen.snapshotScreen()
  }

  snapshotScreenAsMarkdown(): string {
    return this.ptyScreen.snapshotScreenAsMarkdown()
  }

  isExited(): boolean {
    return this.exited
  }

  async stop(): Promise<void> {
    await this.ptyScreen.stop()
  }
}
