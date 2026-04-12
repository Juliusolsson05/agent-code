import { EventEmitter } from 'events'
import { spawn as ptySpawn, type IPty } from 'node-pty'
// @xterm/headless is published as CommonJS; Node's ESM interop can't see its
// named exports, so we import the default and destructure.
import xtermHeadless from '@xterm/headless'

const { Terminal } = xtermHeadless
type TerminalInstance = InstanceType<typeof Terminal>

// PtyScreen — provider-agnostic "child process attached to a headless
// terminal" primitive.
//
// The shared shape between every agent integration we might build
// (Claude Code, Codex, any future TUI-based provider) is:
//
//   1. Spawn a child binary in a node-pty with a chosen cwd + env.
//   2. Pipe its output into an @xterm/headless Terminal so we get
//      a correctly-rendered buffer to snapshot — instead of trying
//      to parse ANSI ourselves, we let xterm do it and walk the
//      resulting cells.
//   3. On every PTY chunk, schedule a throttled flush that emits a
//      snapshot event with both a plain-text view (source of truth
//      for parsers) and a markdown view (bold/italic reconstructed
//      from cell attributes so our renderer can restore formatting
//      the TUI applied via chalk).
//   4. Forward raw bytes out (for high-fidelity recording in the
//      testbench) and accept raw bytes in (keystroke forwarding).
//   5. Resize both the PTY and the xterm in lockstep when the UI
//      changes size.
//   6. Clean up deterministically on exit.
//
// None of that is claude-specific or codex-specific — the provider
// differences live one level up (ClaudeSession / CodexSession) and
// compose a PtyScreen internally. Extracting this base class means
// we fix bugs in the PTY plumbing once and both providers benefit.
//
// Lives under src/core/runtime/ — Node-only. Used by main and the
// testbench. Has no knowledge of Electron, IPC, React, or the DOM.

export type PtyScreenOptions = {
  /** Binary to spawn. No default — providers know their own. */
  binary: string
  /** CLI args passed to the binary. */
  args?: string[]
  /** Working directory. Defaults to process.cwd(). */
  cwd?: string
  /** Terminal columns. Default 120 — matches Claude's default frame
   *  width. Callers that want narrower (e.g. terminal panes) should
   *  override. */
  cols?: number
  /** Terminal rows. Default 40. */
  rows?: number
  /** Extra environment variables to pass to the child. Caller owns
   *  the whole env — we don't auto-merge process.env here because
   *  different providers want different TERM/COLORTERM/entrypoint
   *  flags and mixing them is error-prone. */
  env?: Record<string, string | undefined>
  /** Throttle interval in ms for emitting screen events. Ink/chalk
   *  redraws very frequently and we don't want to flood subscribers.
   *  Default 16 (~60 Hz). Set to 0 to emit on every PTY chunk. */
  snapshotIntervalMs?: number
}

/**
 * Base screen snapshot emitted by PtyScreen. Provider-specific
 * session classes may enrich this with additional fields (e.g.
 * ClaudeSession adds `picker` for the slash-command picker state)
 * before re-emitting to their own subscribers.
 */
export type BaseScreenSnapshot = {
  /** Plain text from translateToString. Source of truth for parsers. */
  plain: string
  /** Same screen with bold/italic cell attributes reconstructed as
   *  markdown syntax (`**...**` / `*...*`). Used by the streaming
   *  card so in-flight markdown formatting survives the screen scrape. */
  markdown: string
}

export type PtyScreenEvents = {
  /** PTY spawned. No payload — provider-specific state (project
   *  dir, session id, etc.) is emitted by the wrapping session class. */
  started: []
  /** Raw PTY bytes. Use for recording / fidelity; prefer the throttled
   *  `screen` event for UI updates. */
  'pty-data': [string]
  /** Throttled dual-snapshot of the terminal buffer. */
  screen: [BaseScreenSnapshot]
  exit: [{ exitCode: number; signal?: number }]
}

export interface PtyScreen {
  on<K extends keyof PtyScreenEvents>(
    event: K,
    listener: (...args: PtyScreenEvents[K]) => void,
  ): this
  off<K extends keyof PtyScreenEvents>(
    event: K,
    listener: (...args: PtyScreenEvents[K]) => void,
  ): this
  emit<K extends keyof PtyScreenEvents>(
    event: K,
    ...args: PtyScreenEvents[K]
  ): boolean
}

/**
 * Build the correct markdown emphasis marker for a state:
 *   bold + italic → ***
 *   bold only     → **
 *   italic only   → *
 *   neither       → ''
 *
 * Used by terminalToMarkdown() to emit paired open/close markers at
 * every state transition. The symmetry is load-bearing — every call
 * to close must match a call to open with the same state pair, or we
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
 * markdown from cell SGR attributes. Exported so the testbench
 * (testbench/replay.ts) can exercise it against recorded fixtures
 * without having to instantiate a full PtyScreen.
 *
 * See the rationale on PtyScreen.snapshotScreenAsMarkdown() below
 * for why this exists.
 */
export function terminalToMarkdown(term: TerminalInstance): string {
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

export class PtyScreen extends EventEmitter {
  private pty: IPty | null = null
  private term: TerminalInstance | null = null
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private flushPending = false
  private exited = false

  private readonly binary: string
  private readonly args: string[]
  private readonly cwd: string
  private readonly cols: number
  private readonly rows: number
  private readonly env: Record<string, string | undefined>
  private readonly snapshotIntervalMs: number

  constructor(options: PtyScreenOptions) {
    super()
    this.binary = options.binary
    this.args = options.args ?? []
    this.cwd = options.cwd ?? process.cwd()
    this.cols = options.cols ?? 120
    this.rows = options.rows ?? 40
    this.env = options.env ?? {}
    this.snapshotIntervalMs = options.snapshotIntervalMs ?? 16
  }

  /**
   * Spawn the child process in a PTY attached to a fresh headless
   * terminal. Resolves once the PTY has been created (synchronously,
   * as far as the caller can tell — node-pty's spawn is fast).
   *
   * Callers that need to set up watchers BEFORE any output lands
   * (e.g., ClaudeSession attaches its JSONL tailer before calling
   * this) should do that work first and then await start().
   */
  async start(): Promise<void> {
    if (this.pty) throw new Error('PtyScreen already started')

    this.term = new Terminal({
      cols: this.cols,
      rows: this.rows,
      allowProposedApi: true,
      scrollback: 10000,
    })

    // Filter undefined env entries — node-pty expects strings only.
    // Caller builds the env from scratch (we don't merge process.env
    // here because different providers want different flags baked in
    // and mixing them produces surprises).
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(this.env)) {
      if (typeof v === 'string') env[k] = v
    }

    this.pty = ptySpawn(this.binary, this.args, {
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
      this.cleanup()
    })

    this.emit('started')
  }

  /** Write raw bytes to the PTY. Used for keystroke synthesis. */
  write(data: string): void {
    this.pty?.write(data)
  }

  /** Resize both the PTY and the headless terminal in lockstep. */
  resize(cols: number, rows: number): void {
    try {
      this.pty?.resize(cols, rows)
      this.term?.resize(cols, rows)
    } catch {
      // node-pty throws on 0/negative dims during transient layouts.
      // Swallow; next resize call lands correctly.
    }
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
   *   Agents like Claude Code use `marked` to parse markdown and
   *   chalk/Ink to convert each token to an ANSI string. `**bold**`
   *   becomes `chalk.bold(text)` — an ANSI bold sequence around the
   *   text. By the time it hits our headless terminal, the `**`
   *   characters are GONE but the bold ATTRIBUTE is set on every
   *   cell in the bold run. `translateToString(true)` returns plain
   *   text with the attributes dropped, which is why our streaming
   *   card used to show unformatted text — we were throwing away
   *   the very formatting we wanted.
   *
   * This method reads each cell's `isBold()` / `isItalic()` attributes,
   * tracks the state across cells, and emits `**` / `*` / `***` markers
   * at every transition. The result is a markdown-ish reconstruction
   * that carries the same formatting the TUI was going to render — just
   * in markdown source form, which we can feed into react-markdown on
   * the renderer side.
   *
   * This is agent-agnostic because both Claude and Codex use chalk-
   * shaped emphasis. Codex may need additional attribute detection
   * later (different color choices, custom underline handling), but
   * the bold+italic baseline is shared.
   *
   * What it captures:
   *   - **bold**  (chalk.bold)
   *   - *italic*  (chalk.italic)
   *   - ***bold italic***  (both attributes set — h1 headings for example)
   *
   * What it misses:
   *   - Inline code (`codespan`): TUIs use a theme color which is
   *     fg-color-mode-dependent. Detecting it requires hardcoding
   *     color values per theme — too brittle for v1. Inline code
   *     renders as plain text here.
   *   - Fenced code blocks: piped through highlight.js which applies
   *     many colors per syntax token. Detecting "this line is code"
   *     from the cell colors isn't reliable. Skipped for now; code
   *     blocks render as plain text during streaming and snap into
   *     full syntax highlighting when the JSONL entry lands.
   *   - Headings: Claude renders h1 as bold+italic+underline, h2 as
   *     bold, etc. We emit them as ***bold italic*** / **bold** which
   *     is close enough — same visual weight, and markdown renderers
   *     handle both as distinct emphasis.
   */
  snapshotScreenAsMarkdown(): string {
    if (!this.term) return ''
    return terminalToMarkdown(this.term)
  }

  /**
   * Direct access to the headless Terminal instance.
   *
   * Exposed so provider-specific code that needs cell-level attribute
   * access (e.g., ClaudeSession's slash command picker detection
   * reads cell foreground colors via `line.getCell(x).getFgColor()`)
   * can reach in without re-implementing the parse. Callers should
   * NOT mutate the terminal — treat the return value as read-only.
   *
   * Returns null before start() has been called.
   */
  getTerminal(): TerminalInstance | null {
    return this.term
  }

  /** True if the PTY has exited. */
  isExited(): boolean {
    return this.exited
  }

  /** Stop: kill the PTY, drop the terminal. Idempotent. */
  async stop(): Promise<void> {
    try {
      this.pty?.kill()
    } catch {
      // already gone
    }
    this.pty = null
    this.cleanup()
  }

  // ---------------------------------------------------------------------------

  private scheduleFlush(): void {
    if (this.flushPending) return
    this.flushPending = true
    this.flushTimer = setTimeout(() => {
      this.flushPending = false
      this.flushTimer = null
      // Emit BOTH plain and markdown snapshots in a single event. The
      // plain version is the source of truth for chrome stripping,
      // marker detection, and baseline comparison. The markdown
      // version carries bold/italic formatting reconstructed from
      // cell attributes and is used by the streaming card for rich
      // rendering. See snapshotScreenAsMarkdown() for why.
      this.emit('screen', {
        plain: this.snapshotScreen(),
        markdown: this.snapshotScreenAsMarkdown(),
      })
    }, this.snapshotIntervalMs)
  }

  private cleanup(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.flushPending = false
  }
}
