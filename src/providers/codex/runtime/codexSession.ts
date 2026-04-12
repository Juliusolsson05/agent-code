import { EventEmitter } from 'events'
import { mkdir, readdir, stat } from 'fs/promises'
import { join } from 'path'
import { watch } from 'chokidar'

// SlashPickerState is defined in multiple places (preload, workspaceStore,
// Claude's parser). Codex doesn't have a slash picker, but ScreenSnapshot
// requires the type for interface compatibility. Import from preload —
// it's the IPC boundary type accessible to main-process code.
import type { SlashPickerState } from '../../../preload/index.js'
import { tailSessionFile, type JsonlEntry } from '../../../shared/runtime/jsonlTailer.js'
import { getCodexSessionsDir } from './projectDir.js'
import { PtyScreen } from '../../../shared/runtime/ptyScreen.js'

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
// Unlike the first integration pass, we DO tail the rollout file now.
// That's load-bearing for three things:
//   1. capturing the provider session/thread id from session_meta
//   2. populating the feed with tool calls + final messages
//   3. making resume work after app reload
//
// Codex stores rollout files in a global date tree instead of Claude's
// per-cwd project dir, so the tailer logic below has two modes:
//   - fresh session: watch ~/.codex/sessions recursively for the first
//     new rollout-*.jsonl file and tail it from offset 0
//   - resume: find the existing rollout file by thread id and tail it
//     directly (Codex resume writes back into the existing file)

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
  private stopJsonlTail: (() => Promise<void>) | null = null
  private exited = false
  private readonly cwd: string
  private readonly resumeSessionId: string | null

  constructor(options: CodexSessionOptions = {}) {
    super()
    this.cwd = options.cwd ?? process.cwd()
    this.resumeSessionId = options.resumeSessionId ?? null

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
    if (this.resumeSessionId) {
      args.push('resume', this.resumeSessionId)
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

    // Forward PTY bytes.
    this.ptyScreen.on('pty-data', data => this.emit('pty-data', data))

    // Emit screen snapshots. No slash-picker enrichment yet —
    // just pass through the base snapshot with a static "not visible"
    // picker so the renderer's picker component stays hidden.
    this.ptyScreen.on('screen', base => {
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
   * Spawn the codex binary and wire the rollout tailer.
   */
  async start(): Promise<void> {
    // Emit the sessions dir as the "project dir" so the renderer
    // has a path to show in the pane header. For Claude this is
    // per-cwd; for codex it's the global sessions root.
    const projectDir = getCodexSessionsDir()
    if (this.resumeSessionId) {
      const rolloutPath = await findCodexRolloutPathById(
        projectDir,
        this.resumeSessionId,
      )
      if (rolloutPath) {
        this.stopJsonlTail = tailSessionFile(
          rolloutPath,
          entry => this.emit('jsonl-entry', entry, rolloutPath),
          err => this.emit('jsonl-error', err),
        )
      }
    } else {
      this.stopJsonlTail = await tailNewCodexSessionFile(
        projectDir,
        (entry, file) => this.emit('jsonl-entry', entry, file),
        err => this.emit('jsonl-error', err),
      )
    }
    await this.ptyScreen.start()
    this.emit('started', { projectDir })
  }

  write(data: string): void {
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
    await this.stopJsonlTail?.().catch(() => {})
    await this.ptyScreen.stop()
  }
}

const CODEX_ROLLOUT_RE =
  /^rollout-(.+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i

async function tailNewCodexSessionFile(
  sessionsDir: string,
  onEntry: (entry: JsonlEntry, file: string) => void,
  onError?: (err: Error) => void,
): Promise<() => Promise<void>> {
  await mkdir(sessionsDir, { recursive: true })

  const existing = new Set<string>()
  const primingWatcher = watch(sessionsDir, {
    persistent: true,
    ignoreInitial: false,
    depth: 4,
  })
  await new Promise<void>(resolve => {
    primingWatcher.on('add', filePath => existing.add(filePath))
    primingWatcher.on('ready', resolve)
  })
  await primingWatcher.close()

  let stopTail: (() => Promise<void>) | null = null
  const watcher = watch(sessionsDir, {
    persistent: true,
    ignoreInitial: true,
    depth: 4,
  })
  watcher.on('add', filePath => {
    if (stopTail) return
    const name = filePath.split('/').pop() ?? ''
    if (!CODEX_ROLLOUT_RE.test(name)) return
    if (existing.has(filePath)) return
    stopTail = tailSessionFile(
      filePath,
      entry => onEntry(entry, filePath),
      onError,
    )
  })
  watcher.on('error', err => onError?.(err as Error))

  return async () => {
    await watcher.close()
    await stopTail?.().catch(() => {})
  }
}

async function findCodexRolloutPathById(
  dir: string,
  sessionId: string,
  depth = 0,
): Promise<string | null> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return null
  }

  for (const name of names) {
    const full = join(dir, name)
    try {
      const info = await stat(full)
      if (info.isDirectory() && depth < 3) {
        const nested = await findCodexRolloutPathById(full, sessionId, depth + 1)
        if (nested) return nested
        continue
      }
      if (!info.isFile()) continue
      const match = CODEX_ROLLOUT_RE.exec(name)
      if (match?.[2] === sessionId) return full
    } catch {
      // Skip unreadable filesystem entries.
    }
  }

  return null
}
