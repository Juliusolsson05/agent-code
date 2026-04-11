import { EventEmitter } from 'events'
import { spawn as ptySpawn, type IPty } from 'node-pty'
// @xterm/headless is published as CommonJS; Node's ESM interop can't see its
// named exports, so we import the default and destructure.
import xtermHeadless from '@xterm/headless'

import { join } from 'path'

import {
  detectSlashPicker,
  type SlashPickerState,
} from '../parsers/slashCommandPicker.js'
import { getProjectDirForCwd } from './projectDir.js'
import {
  tailNewSessionFile,
  tailSessionFile,
  type JsonlEntry,
} from './jsonlTailer.js'

const { Terminal } = xtermHeadless

/**
 * Build the correct markdown emphasis marker for a state:
 *   bold + italic → ***
 *   bold only     → **
 *   italic only   → *
 *   neither       → ''
 *
 * Used by terminalToMarkdown() to emit paired open/close markers at
 * every state transition. The symmetry is load-bearing — every call to
 * close must match a call to open with the same state pair, or we
 * leave unbalanced markers.
 */
function emphasisMarker(bold: boolean, italic: boolean): string {
  if (bold && italic) return '***'
  if (bold) return '**'
  if (italic) return '*'
  return ''
}

/**
 * Pure function: walk a Terminal's active buffer and reconstruct
 * markdown from cell SGR attributes. Extracted from ClaudeSession so
 * the testbench (testbench/replay.ts) can exercise it against recorded
 * fixtures without having to instantiate a full session.
 *
 * See the detailed rationale on snapshotScreenAsMarkdown() below.
 */
export function terminalToMarkdown(
  term: InstanceType<typeof Terminal>,
): string {
  const buf = term.buffer.active
  const out: string[] = []

  const cell = (buf as { getNullCell?: () => unknown }).getNullCell?.() as
    | { isBold(): number; isItalic(): number; getChars(): string }
    | undefined

  for (let y = 0; y < buf.length; y++) {
    const line = buf.getLine(y)
    if (!line) {
      out.push('')
      continue
    }

    let row = ''
    let inBold = false
    let inItalic = false

    for (let x = 0; x < line.length; x++) {
      const c = (cell ? line.getCell(x, cell as never) : line.getCell(x)) ?? null
      if (!c) continue
      const chars = c.getChars() || ' '
      const nextBold = c.isBold() !== 0
      const nextItalic = c.isItalic() !== 0

      if (nextBold !== inBold || nextItalic !== inItalic) {
        row += emphasisMarker(inBold, inItalic)
        row += emphasisMarker(nextBold, nextItalic)
        inBold = nextBold
        inItalic = nextItalic
      }

      row += chars
    }

    row += emphasisMarker(inBold, inItalic)
    out.push(row.replace(/[ \t]+$/, ''))
  }

  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out.join('\n')
}

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
export type ScreenSnapshot = {
  /** Plain text from translateToString. Source of truth for parsers. */
  plain: string
  /** Same screen with bold/italic cell attributes reconstructed as
   *  markdown syntax (`**...**` / `*...*`). Used by the streaming card
   *  so CC's in-flight markdown formatting survives our screen scrape. */
  markdown: string
  /** Structured slash command picker state detected from cell fg
   *  colors. `visible: false` when no picker is on screen — the
   *  common case. See src/core/parsers/slashCommandPicker.ts for
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
  private readonly resumeSessionId: string | null

  constructor(options: ClaudeSessionOptions = {}) {
    super()
    this.cwd = options.cwd ?? process.cwd()
    this.cols = options.cols ?? 120
    this.rows = options.rows ?? 40
    this.binary = options.binary ?? 'claude'
    this.extraEnv = options.env ?? {}
    this.snapshotIntervalMs = options.snapshotIntervalMs ?? 16
    this.resumeSessionId = options.resumeSessionId ?? null
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

    // Forward `--resume <uuid>` when we're resuming an existing session.
    // CC validates the UUID itself and falls back to an interactive
    // picker if the uuid doesn't match a file in the project — but we
    // only ever pass uuids we just listed from the filesystem, so the
    // validation should always pass.
    const args: string[] = []
    if (this.resumeSessionId) {
      args.push('--resume', this.resumeSessionId)
    }

    this.pty = ptySpawn(this.binary, args, {
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

  /**
   * Capture the buffer, but reconstruct markdown syntax from cell-level
   * SGR attributes as we go.
   *
   * Why this exists:
   *   CC uses `marked` to parse markdown and `formatToken` in
   *   claude-code-src/utils/markdown.ts to convert each token to an ANSI
   *   string via chalk. `**bold**` becomes `chalk.bold(text)` — an ANSI
   *   bold sequence around the text. By the time it hits our headless
   *   terminal, the `**` characters are GONE but the bold ATTRIBUTE is
   *   set on every cell in the bold run. `translateToString(true)`
   *   returns plain text with the attributes dropped, which is why our
   *   streaming card was showing unformatted text — we were throwing
   *   away the very formatting we wanted.
   *
   * This method reads each cell's `isBold()` / `isItalic()` attributes,
   * tracks the state across cells, and emits `**` / `*` / `***` markers
   * at every transition. The result is a markdown-ish reconstruction
   * that carries the same formatting CC was going to render — just in
   * markdown source form, which we can feed into react-markdown on the
   * renderer side.
   *
   * What it captures:
   *   - **bold**  (chalk.bold)
   *   - *italic*  (chalk.italic)
   *   - ***bold italic***  (both attributes set — h1 headings for example)
   *
   * What it misses:
   *   - Inline code (`codespan`): CC uses a theme "permission" color
   *     which is fg-color-mode-dependent. Detecting it requires
   *     hardcoding specific color values per theme — too brittle for
   *     v1. Inline code will render as plain text.
   *   - Fenced code blocks: CC pipes them through highlight.js which
   *     applies many colors per syntax token. Detecting "this line is
   *     code" from the cell colors isn't reliable — a prose line with a
   *     single colored word looks the same. Skipped for now; code
   *     blocks will render as plain text during streaming and snap into
   *     full syntax highlighting when the JSONL entry lands.
   *   - Headings: CC renders h1 as bold+italic+underline, h2 as bold,
   *     etc. We'll emit them as ***bold italic*** / **bold** which is
   *     close enough — same visual weight, and markdown renderers
   *     handle both as distinct emphasis.
   */
  snapshotScreenAsMarkdown(): string {
    if (!this.term) return ''
    return terminalToMarkdown(this.term)
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
      // Emit BOTH plain and markdown snapshots in a single event. The
      // plain version is still the source of truth for chrome stripping,
      // marker detection, and baseline comparison (so parsers stay
      // stable). The markdown version carries bold/italic formatting
      // reconstructed from cell attributes and is used by the streaming
      // card for rich rendering. See snapshotScreenAsMarkdown() for why
      // this dual-channel approach exists.
      this.emit('screen', {
        plain: this.snapshotScreen(),
        markdown: this.snapshotScreenAsMarkdown(),
        // detectSlashPicker walks the buffer once per frame reading
        // cell fg colors — O(rows × cols) but rows/cols are bounded
        // (~40×120) and each cell access is a single call. Negligible
        // compared to the cost of just shipping a frame over IPC.
        picker: this.term ? detectSlashPicker(this.term) : { visible: false, items: [] },
      })
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
