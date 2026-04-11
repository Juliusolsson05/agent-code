import { EventEmitter } from 'events'
import { join } from 'path'

import {
  detectSlashPicker,
  type SlashPickerState,
} from '../parsers/claude/slashCommandPicker.js'
import {
  tailNewSessionFile,
  tailSessionFile,
  type JsonlEntry,
} from './jsonlTailer.js'
import { getProjectDirForCwd } from './projectDir.js'
import { PtyScreen, terminalToMarkdown } from './ptyScreen.js'

// Re-export terminalToMarkdown so existing callers (testbench/replay.ts)
// that imported it from this file keep working. The actual implementation
// now lives in ptyScreen.ts — it's agent-agnostic — but the testbench
// shouldn't need to care about that refactor.
export { terminalToMarkdown }

// Lives under src/core/runtime/ — Node-only. Used by the Electron main
// process AND the standalone testbench. Has NO knowledge of Electron,
// IPC, React, or the DOM.
//
// ClaudeSession composes a PtyScreen (the provider-agnostic PTY + xterm
// primitive) with the Claude-specific wiring:
//   - Spawns `claude` with the CLAUDE_CODE_ENTRYPOINT env flag so CC
//     knows it's running inside a desktop wrapper.
//   - Passes `--resume <uuid>` when resuming an existing session.
//   - Attaches a JSONL tailer to ~/.claude/projects/<sanitized-cwd>/
//     before the PTY spawns so we don't miss any transcript entries.
//   - Enriches the base PtyScreen screen snapshot with Claude's slash
//     command picker state (detected from cell fg colors on every
//     frame).
//
// The public event shape is unchanged from the pre-refactor version —
// existing callers in main / testbench didn't need to change. The
// difference is that the PTY + xterm + throttled flush + dual snapshot
// plumbing now lives in one place that CodexSession will also use.

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
  /**
   * If set, spawn claude with `--resume <uuid>` and tail the existing
   * `<projectDir>/<uuid>.jsonl` file from its current content instead
   * of waiting for a new file. The first wave of `jsonl-entry` events
   * after `started` will carry the session's entire history, which the
   * renderer should render as the feed.
   */
  resumeSessionId?: string
}

/**
 * The events emitted by a ClaudeSession. Subscribe via `.on('eventName', cb)`.
 *
 *   started        — PTY spawned successfully; payload is the absolute path
 *                    of the CC project dir we're tailing for JSONL entries
 *   pty-data       — raw bytes received from the PTY (string); use this for
 *                    full fidelity recording in the testbench
 *   screen         — throttled snapshot of the headless terminal buffer as
 *                    plain text + markdown + slash picker state; use this
 *                    for the live streaming preview in the renderer
 *   jsonl-entry    — a parsed JSONL entry from CC's transcript file
 *   jsonl-error    — non-fatal parse / tail error from the jsonl tailer
 *   exit           — the PTY child exited; payload is { exitCode, signal? }
 *
 * Listeners can be added before or after `start()`. Events are buffered
 * naturally by Node's EventEmitter — but if you attach AFTER start() you
 * may miss the very first frames.
 */
export type ScreenSnapshot = {
  /** Plain text from translateToString. Source of truth for parsers. */
  plain: string
  /** Same screen with bold/italic cell attributes reconstructed as
   *  markdown syntax (`**...**` / `*...*`). Used by the streaming card
   *  so CC's in-flight markdown formatting survives our screen scrape. */
  markdown: string
  /** Structured slash command picker state detected from cell fg
   *  colors. `visible: false` when no picker is on screen — the
   *  common case. See src/core/parsers/claude/slashCommandPicker.ts for
   *  the detection algorithm. Ships with every snapshot so the
   *  renderer can react to picker opens/closes immediately. */
  picker: SlashPickerState
}

export type ClaudeSessionEvents = {
  started: [{ projectDir: string }]
  'pty-data': [string]
  screen: [ScreenSnapshot]
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
  private readonly ptyScreen: PtyScreen
  private stopJsonlTail: (() => Promise<void>) | null = null
  private exited = false

  private readonly cwd: string
  private readonly resumeSessionId: string | null

  constructor(options: ClaudeSessionOptions = {}) {
    super()
    this.cwd = options.cwd ?? process.cwd()
    this.resumeSessionId = options.resumeSessionId ?? null

    // Build the env CC expects. We start from process.env so PATH,
    // HOME, and friends propagate — a shell without PATH can't run
    // any of the user's tools — then force the TERM / COLORTERM
    // flags so Ink renders cleanly, then set the
    // CLAUDE_CODE_ENTRYPOINT flag so CC takes the desktop-wrapper
    // code path (matches main.tsx:825 of claude-code-src:
    // clientType === 'claude-desktop'). Caller overrides from
    // options.env win last.
    //
    // PtyScreen deliberately does NOT merge process.env itself —
    // different providers want different flags baked in and mixing
    // them produces surprises — so we build the full env here.
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

    // Forward `--resume <uuid>` when we're resuming an existing session.
    // CC validates the UUID itself and falls back to an interactive
    // picker if the uuid doesn't match a file in the project — but we
    // only ever pass uuids we just listed from the filesystem, so the
    // validation should always pass.
    const args: string[] = []
    if (this.resumeSessionId) {
      args.push('--resume', this.resumeSessionId)
    }

    this.ptyScreen = new PtyScreen({
      binary: options.binary ?? 'claude',
      args,
      cwd: this.cwd,
      cols: options.cols ?? 120,
      rows: options.rows ?? 40,
      env,
      snapshotIntervalMs: options.snapshotIntervalMs ?? 16,
    })

    // Forward PTY bytes straight through — used by the testbench for
    // high-fidelity recording. Not used by the renderer (it consumes
    // `screen` instead).
    this.ptyScreen.on('pty-data', data => this.emit('pty-data', data))

    // Enrich the base screen snapshot with Claude's slash command
    // picker state before re-emitting. The picker detector walks the
    // headless xterm buffer reading cell fg colors — O(rows × cols)
    // per frame, bounded to ~40×120, negligible compared to shipping
    // a frame over IPC.
    this.ptyScreen.on('screen', base => {
      const term = this.ptyScreen.getTerminal()
      this.emit('screen', {
        plain: base.plain,
        markdown: base.markdown,
        picker: term ? detectSlashPicker(term) : { visible: false, items: [] },
      })
    })

    this.ptyScreen.on('exit', ({ exitCode, signal }) => {
      this.exited = true
      this.emit('exit', { exitCode, signal })
      void this.cleanup()
    })
  }

  /**
   * Resolve the JSONL project dir, attach the watcher BEFORE spawning so we
   * don't miss the file-creation event, then spawn `claude` in a PTY.
   * Resolves once the PTY has been created. Use `on('exit')` to know when
   * the child terminates.
   */
  async start(): Promise<void> {
    const projectDir = await getProjectDirForCwd(this.cwd)

    // JSONL tailer selection:
    //   - New session: wait for CC to create a NEW <uuid>.jsonl file
    //     we haven't seen yet. tailNewSessionFile snapshots the
    //     existing files first so old sessions don't get re-emitted.
    //   - Resume: we KNOW the file path — it's
    //     <projectDir>/<resumeSessionId>.jsonl. Tail it directly so
    //     the full existing history is emitted to the renderer as
    //     `jsonl-entry` events and the feed rehydrates. FileTailer's
    //     readNew() reads from offset 0 on construct, which gives
    //     us the backfill for free.
    if (this.resumeSessionId) {
      const filePath = join(projectDir, `${this.resumeSessionId}.jsonl`)
      const stop = tailSessionFile(
        filePath,
        entry => this.emit('jsonl-entry', entry, filePath),
        err => this.emit('jsonl-error', err),
      )
      this.stopJsonlTail = stop
    } else {
      this.stopJsonlTail = await tailNewSessionFile(
        projectDir,
        (entry, file) => this.emit('jsonl-entry', entry, file),
        err => this.emit('jsonl-error', err),
      )
    }

    await this.ptyScreen.start()
    this.emit('started', { projectDir })
  }

  /** Write raw bytes to the PTY. Used for keystroke synthesis. */
  write(data: string): void {
    this.ptyScreen.write(data)
  }

  /** Resize both the PTY and the headless terminal in lockstep. */
  resize(cols: number, rows: number): void {
    this.ptyScreen.resize(cols, rows)
  }

  /**
   * Capture the headless terminal's current visible buffer as plain text.
   * Synchronous — call any time after `start()`. Forwards to PtyScreen.
   */
  snapshotScreen(): string {
    return this.ptyScreen.snapshotScreen()
  }

  /**
   * Capture the buffer with bold/italic reconstructed from cell
   * attributes. Forwards to PtyScreen.snapshotScreenAsMarkdown.
   */
  snapshotScreenAsMarkdown(): string {
    return this.ptyScreen.snapshotScreenAsMarkdown()
  }

  /** True if the PTY has exited. */
  isExited(): boolean {
    return this.exited
  }

  /** Stop the session: kill the PTY, close the JSONL watcher. Idempotent. */
  async stop(): Promise<void> {
    await this.ptyScreen.stop()
    await this.cleanup()
  }

  // ---------------------------------------------------------------------------

  private async cleanup(): Promise<void> {
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
