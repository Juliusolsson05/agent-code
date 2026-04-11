import { EventEmitter } from 'events'
import { spawn as ptySpawn, type IPty } from 'node-pty'

// TerminalSession — a plain shell session that the user drives directly.
//
// Counterpart to ClaudeSession. Where ClaudeSession spawns `claude`
// and owns a headless terminal parser + JSONL tailer because cc-shell
// renders its own UI over the top, TerminalSession is the simpler
// case: spawn the user's login shell, pipe raw bytes to whoever's
// subscribed, accept raw bytes back, and let the renderer's xterm.js
// instance do the actual terminal emulation.
//
// Lives under src/core/runtime/ alongside ClaudeSession so both can be
// held in a single SessionManager registry on the main side. No
// Electron, no React, no DOM — pure Node.
//
// Why a separate class rather than a ClaudeSession variant:
//   - ClaudeSession's whole reason-to-exist is the headless terminal
//     + JSONL plumbing that only makes sense when the child is
//     Claude Code. None of that applies here. A terminal doesn't
//     want to pay the cost of a 40-row xterm buffer parse on every
//     PTY chunk, doesn't have a JSONL file, doesn't have a slash
//     picker, and doesn't need chrome-stripping screen snapshots.
//   - Subclassing would force every ClaudeSession consumer to
//     ignore fields it doesn't use, and would bake the assumption
//     that every future "session kind" shares the Claude plumbing.
//   - Two small classes + a union type in SessionManager is the
//     straightforward shape.

export type TerminalSessionOptions = {
  /** Working directory the shell will launch in. Defaults to process.cwd(). */
  cwd?: string
  /** Terminal columns. Default 80 (xterm.js' natural default). */
  cols?: number
  /** Terminal rows. Default 24. */
  rows?: number
  /**
   * Shell binary to spawn. Defaults to $SHELL, then /bin/zsh, then
   * /bin/bash, then 'sh' as a last resort. We don't try to be clever
   * about Windows — if/when cc-shell runs there we'll add a branch.
   */
  shell?: string
  /** Extra environment overrides for the spawned shell. */
  env?: Record<string, string | undefined>
}

/**
 * Events this class emits. Much narrower than ClaudeSession's set:
 *
 *   started — the shell PTY was spawned successfully. No payload;
 *             there's no equivalent of CC's JSONL project dir here.
 *   data    — raw PTY output (string). Forward straight to xterm.js
 *             on the renderer side.
 *   exit    — the shell process exited. Payload mirrors ClaudeSession's
 *             exit shape so the manager can forward both to the same
 *             'exit' channel.
 */
export type TerminalSessionEvents = {
  started: []
  data: [string]
  exit: [{ exitCode: number; signal?: number }]
}

export interface TerminalSession {
  on<K extends keyof TerminalSessionEvents>(
    event: K,
    listener: (...args: TerminalSessionEvents[K]) => void,
  ): this
  off<K extends keyof TerminalSessionEvents>(
    event: K,
    listener: (...args: TerminalSessionEvents[K]) => void,
  ): this
  emit<K extends keyof TerminalSessionEvents>(
    event: K,
    ...args: TerminalSessionEvents[K]
  ): boolean
}

export class TerminalSession extends EventEmitter {
  private pty: IPty | null = null
  private exited = false

  private readonly cwd: string
  private readonly cols: number
  private readonly rows: number
  private readonly shell: string
  private readonly extraEnv: Record<string, string | undefined>

  constructor(options: TerminalSessionOptions = {}) {
    super()
    this.cwd = options.cwd ?? process.cwd()
    this.cols = options.cols ?? 80
    this.rows = options.rows ?? 24
    // Resolve the shell binary with a small fallback chain. $SHELL is
    // the user's preference; the rest are sane defaults that exist on
    // almost every unix. We don't check for existence — if none of
    // them are present the spawn will error and the exit handler
    // below will surface it.
    this.shell =
      options.shell ??
      process.env.SHELL ??
      '/bin/zsh'
    this.extraEnv = options.env ?? {}
  }

  /**
   * Spawn the shell in a PTY. Resolves once the PTY is alive.
   * Use `on('exit')` to know when the child terminates.
   */
  async start(): Promise<void> {
    if (this.pty) throw new Error('TerminalSession already started')

    // Build the env from scratch so we control exactly what's passed.
    // Start with the current process env so PATH, HOME, and friends
    // propagate — a shell without PATH is a shell that can't run any
    // of the user's tools.
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === 'string') env[k] = v
    }
    // Force a color-capable TERM so ls, git, and the usual suspects
    // render correctly. xterm-256color is the modern default that
    // every well-behaved terminal understands.
    env.TERM = 'xterm-256color'
    env.COLORTERM = 'truecolor'
    // Caller overrides win last so integrations that need to
    // override TERM or add flags can do so.
    for (const [k, v] of Object.entries(this.extraEnv)) {
      if (v === undefined) delete env[k]
      else env[k] = v
    }

    this.pty = ptySpawn(this.shell, [], {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      env,
    })

    this.pty.onData((data: string) => {
      this.emit('data', data)
    })

    this.pty.onExit(({ exitCode, signal }) => {
      this.exited = true
      this.emit('exit', { exitCode, signal })
      this.pty = null
    })

    this.emit('started')
  }

  /** Write bytes to the PTY. Used for keystroke forwarding. */
  write(data: string): void {
    this.pty?.write(data)
  }

  /**
   * Resize the PTY. Called from the renderer whenever the tile
   * containing this terminal resizes and xterm.js' FitAddon
   * recomputes cell dimensions.
   */
  resize(cols: number, rows: number): void {
    try {
      this.pty?.resize(cols, rows)
    } catch {
      // node-pty throws if cols/rows are zero or negative — can
      // happen during a transient layout (a hidden tab briefly
      // reports 0×0). Swallow; a subsequent resize will land.
    }
  }

  /** True if the PTY has exited. */
  isExited(): boolean {
    return this.exited
  }

  /** Stop the session: kill the PTY. Idempotent. */
  async stop(): Promise<void> {
    try {
      this.pty?.kill()
    } catch {
      // already gone
    }
    this.pty = null
  }
}
