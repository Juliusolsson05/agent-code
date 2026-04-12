import { randomUUID } from 'crypto'
import { EventEmitter } from 'events'

import {
  ClaudeSession,
  type ScreenSnapshot,
} from '../providers/claude/runtime/claudeSession.js'
import { CodexSession } from '../providers/codex/runtime/codexSession.js'
import { TerminalSession } from '../shared/runtime/terminalSession.js'
import type { JsonlEntry } from '../shared/runtime/jsonlTailer.js'

// SessionManager: a thin registry on top of ClaudeSession / TerminalSession
// that lets the main process run N sessions in parallel. Every event
// every session emits is re-emitted here with the sessionId attached,
// so the Electron IPC forwarder can attach one listener per channel
// instead of N×channels.
//
// Why not just use a plain Map<id, ClaudeSession> and attach listeners
// directly from main/index.ts:
//   - main/index.ts would need to re-subscribe every time a session is
//     spawned, and unsubscribe on kill, doubling the bookkeeping.
//   - The forwarder would have to multiplex events from N sessions into
//     one IPC channel per event type anyway — the mux belongs here where
//     it's testable in isolation.
//
// Multi-kind support: cc-shell can host two kinds of sessions per pane
// today — a Claude Code session (ClaudeSession) or a plain shell
// terminal (TerminalSession). The registry holds a union; spawn()
// dispatches on options.kind; events from both are funnelled through
// the same ManagerEvents map with a 'kind' tag on each payload so the
// IPC forwarder can emit them on kind-specific channels if it wants
// (today the renderer just checks the kind on its side).

export type SessionKind = 'claude' | 'codex' | 'terminal'

export type ManagerEvents = {
  started: [{ sessionId: string; kind: SessionKind; projectDir?: string }]
  'pty-data': [{ sessionId: string; data: string }]
  /** Emitted only by Claude sessions — the scraped TUI snapshot. */
  screen: [{ sessionId: string } & ScreenSnapshot]
  /** Emitted only by Claude sessions — parsed JSONL entries. */
  'jsonl-entry': [{ sessionId: string; entry: JsonlEntry; file: string }]
  'jsonl-error': [{ sessionId: string; error: Error }]
  /** Emitted only by terminal sessions — raw PTY output for xterm.js. */
  'terminal-data': [{ sessionId: string; data: string }]
  exit: [{ sessionId: string; exitCode: number; signal?: number }]
}

export type SpawnOptions = {
  /** Which kind of session to spawn. Defaults to 'claude' so the
   *  pre-existing call sites keep working without a kind arg. */
  kind?: SessionKind
  cwd: string
  cols?: number
  rows?: number
  /** Claude only: if set, spawn with --resume <uuid> and tail the
   *  existing session file. Silently ignored for terminal sessions. */
  resumeSessionId?: string
}

export interface SessionManager {
  on<K extends keyof ManagerEvents>(
    event: K,
    listener: (...args: ManagerEvents[K]) => void,
  ): this
  off<K extends keyof ManagerEvents>(
    event: K,
    listener: (...args: ManagerEvents[K]) => void,
  ): this
  emit<K extends keyof ManagerEvents>(
    event: K,
    ...args: ManagerEvents[K]
  ): boolean
}

// Internal registry shape: we store the concrete instance plus its
// kind so kill/write/resize can dispatch without sniffing the object.
type RegistryEntry =
  | { kind: 'claude'; session: ClaudeSession }
  | { kind: 'codex'; session: CodexSession }
  | { kind: 'terminal'; session: TerminalSession }

// Rolling buffer cap for terminal replay. 256 KB is enough to hold
// the recent scrollback of a normal interactive shell session —
// well beyond "the shell prompt and a few commands ago" which is
// the actual requirement. Past the cap we keep the tail (newest
// content wins) so long-running shells don't blow up memory.
const TERMINAL_BUFFER_CAP = 256 * 1024

export class SessionManager extends EventEmitter {
  private readonly sessions = new Map<string, RegistryEntry>()

  // Terminal attach/replay state.
  //
  // Why: when the renderer opens a new terminal pane, the sequence
  // is (1) spawn the session on the main side, (2) IPC invoke
  // resolves with sessionId, (3) renderer re-renders, (4)
  // TerminalLeaf mounts, (5) useEffect runs and subscribes to
  // 'session:terminal-data'. Between steps 1 and 5 the shell has
  // already started, sourced its rc files, and printed its prompt —
  // all of which fires as 'data' events on the TerminalSession that
  // reach main before any subscriber exists. Without buffering
  // those events are dropped, and the user sees an empty xterm
  // with a blinking cursor: the shell is waiting for input but
  // there's nothing on screen.
  //
  // Fix is two-part:
  //   - Buffer every byte of PTY output per session in
  //     `terminalBuffers`. Subject to TERMINAL_BUFFER_CAP.
  //   - Only broadcast 'terminal-data' events to the renderer
  //     AFTER the renderer has called attachTerminal(sessionId),
  //     which atomically returns the current buffer AND flips
  //     the attached flag. Before attach, data accumulates in the
  //     buffer silently.
  //
  // The atomic grab-and-attach is critical: if we broadcast while
  // the buffer was still accumulating, the renderer would receive
  // duplicate bytes (once in the buffer, once as a live event).
  // Toggling the flag in the same synchronous tick as the buffer
  // read means no data can slip through between the two.
  private readonly terminalBuffers = new Map<string, string>()
  private readonly terminalAttached = new Set<string>()

  /**
   * Spawn a new session and return its sessionId. Blocks until the PTY
   * is spawned — after this resolves the caller can immediately start
   * sending input via `write()`.
   *
   * For Claude sessions, start() also attaches the JSONL watcher; for
   * terminal sessions it's just the PTY spawn.
   */
  async spawn(options: SpawnOptions): Promise<string> {
    const kind: SessionKind = options.kind ?? 'claude'
    const sessionId = randomUUID()

    if (kind === 'claude') {
      const session = new ClaudeSession({
        cwd: options.cwd,
        cols: options.cols ?? 120,
        rows: options.rows ?? 40,
        snapshotIntervalMs: 16,
        resumeSessionId: options.resumeSessionId,
      })

      // Wire every ClaudeSession event to a manager-level event with
      // sessionId attached. The main-process IPC forwarder listens once
      // here and dispatches to the renderer with the id included.
      session.on('started', ({ projectDir }) =>
        this.emit('started', { sessionId, kind, projectDir }),
      )
      session.on('pty-data', data =>
        this.emit('pty-data', { sessionId, data }),
      )
      session.on('screen', snap =>
        this.emit('screen', { sessionId, ...snap }),
      )
      session.on('jsonl-entry', (entry, file) =>
        this.emit('jsonl-entry', { sessionId, entry, file }),
      )
      session.on('jsonl-error', error =>
        this.emit('jsonl-error', { sessionId, error }),
      )
      session.on('exit', ({ exitCode, signal }) => {
        this.emit('exit', { sessionId, exitCode, signal })
        // Clean up the registry entry when the child exits so kill() and
        // list() stay accurate. We intentionally DON'T re-spawn here —
        // the renderer decides what to do on exit (probably: mark the
        // pane dead, offer relaunch).
        this.sessions.delete(sessionId)
      })

      this.sessions.set(sessionId, { kind: 'claude', session })
      await session.start()
      return sessionId
    }

    if (kind === 'codex') {
      const session = new CodexSession({
        cwd: options.cwd,
        cols: options.cols ?? 120,
        rows: options.rows ?? 40,
        resumeSessionId: options.resumeSessionId,
      })

      // Wire events — same shape as Claude so the IPC forwarder
      // in main/index.ts doesn't need codex-specific branches.
      session.on('started', ({ projectDir }) =>
        this.emit('started', { sessionId, kind, projectDir }),
      )
      session.on('pty-data', data =>
        this.emit('pty-data', { sessionId, data }),
      )
      session.on('screen', snap =>
        this.emit('screen', { sessionId, ...snap }),
      )
      session.on('jsonl-entry', (entry, file) =>
        this.emit('jsonl-entry', { sessionId, entry, file }),
      )
      session.on('jsonl-error', error =>
        this.emit('jsonl-error', { sessionId, error }),
      )
      session.on('exit', ({ exitCode, signal }) => {
        this.emit('exit', { sessionId, exitCode, signal })
        this.sessions.delete(sessionId)
      })

      this.sessions.set(sessionId, { kind: 'codex', session })
      await session.start()
      return sessionId
    }

    // kind === 'terminal'
    const session = new TerminalSession({
      cwd: options.cwd,
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
    })

    // Initialize an empty buffer entry NOW, before start() fires any
    // data events. The buffer accumulates every byte of PTY output
    // and is replayed to the renderer on attach — see the block
    // comment on terminalBuffers above for the full reasoning.
    this.terminalBuffers.set(sessionId, '')

    // Terminal sessions only emit started / data / exit. The 'data'
    // event carries raw PTY bytes for xterm.js on the renderer side;
    // we forward it on a dedicated 'terminal-data' channel so the
    // renderer can route it straight to xterm without the code path
    // for Claude's structured events getting involved.
    session.on('started', () =>
      this.emit('started', { sessionId, kind, projectDir: undefined }),
    )
    session.on('data', data => {
      // Always append to the rolling buffer so a later attach can
      // replay the full history. Cap at TERMINAL_BUFFER_CAP —
      // longer sessions just lose the oldest bytes, which is the
      // standard terminal scrollback behavior.
      const prev = this.terminalBuffers.get(sessionId) ?? ''
      let next = prev + data
      if (next.length > TERMINAL_BUFFER_CAP) {
        next = next.slice(next.length - TERMINAL_BUFFER_CAP)
      }
      this.terminalBuffers.set(sessionId, next)
      // Only broadcast live events AFTER the renderer has attached.
      // Before attach, the data is still in the buffer and will be
      // replayed when the renderer calls attachTerminal. See the
      // block comment on terminalBuffers for why this is
      // race-free.
      if (this.terminalAttached.has(sessionId)) {
        this.emit('terminal-data', { sessionId, data })
      }
    })
    session.on('exit', ({ exitCode, signal }) => {
      this.emit('exit', { sessionId, exitCode, signal })
      this.sessions.delete(sessionId)
      this.terminalBuffers.delete(sessionId)
      this.terminalAttached.delete(sessionId)
    })

    this.sessions.set(sessionId, { kind: 'terminal', session })
    await session.start()
    return sessionId
  }

  /**
   * Terminal attach/replay entry point.
   *
   * Called by the renderer when a TerminalLeaf mounts and wants to
   * hook up its xterm.js instance to an already-running terminal
   * session. Returns the current output buffer AND flips the
   * attached flag, both synchronously in the same tick so no PTY
   * data can slip between the two operations.
   *
   * Usage from the renderer (see TerminalLeaf.tsx):
   *   1. Subscribe to 'session:terminal-data' first so no events
   *      after attach are missed.
   *   2. Call attachTerminal(sessionId); write returned buffer to
   *      xterm. Any live events that arrived between subscribe and
   *      this point must be queued and written AFTER the buffer —
   *      see the queue logic in TerminalLeaf.
   *   3. Subsequent live events write directly to xterm.
   *
   * Returns '' if the session doesn't exist or isn't a terminal —
   * silently safe so a stale attach call on a dead session doesn't
   * error.
   */
  attachTerminal(sessionId: string): string {
    const entry = this.sessions.get(sessionId)
    if (!entry || entry.kind !== 'terminal') return ''
    const buffer = this.terminalBuffers.get(sessionId) ?? ''
    // Flip the attach flag in the SAME synchronous block as reading
    // the buffer. JavaScript is single-threaded and event emission
    // can only happen on a later tick, so nothing can sneak in.
    this.terminalAttached.add(sessionId)
    return buffer
  }

  /**
   * Write bytes to a session's PTY. Silently no-ops if the session
   * doesn't exist — this happens naturally if a session exits between
   * the renderer queueing input and the main process handling it.
   */
  write(sessionId: string, data: string): boolean {
    const entry = this.sessions.get(sessionId)
    if (!entry) {
      // A silent miss here is brutal to debug from the renderer: the composer
      // clears, the feed may show an optimistic user row, and nothing ever
      // reaches the PTY. Surface the miss to callers so they can log/retain
      // the draft instead of pretending the send succeeded.
      return false
    }
    entry.session.write(data)
    return true
  }

  /** Resize a session's terminal + PTY. No-op if session doesn't exist. */
  resize(sessionId: string, cols: number, rows: number): void {
    this.sessions.get(sessionId)?.session.resize(cols, rows)
  }

  /**
   * Kill a session and remove it from the registry. Returns true if
   * the session existed and was killed.
   */
  async kill(sessionId: string): Promise<boolean> {
    const entry = this.sessions.get(sessionId)
    if (!entry) return false
    await entry.session.stop()
    this.sessions.delete(sessionId)
    return true
  }

  /** List all live session ids. Used for state save / debug. */
  list(): string[] {
    return Array.from(this.sessions.keys())
  }

  /** Kill every live session. Called on app quit. */
  async killAll(): Promise<void> {
    const ids = this.list()
    await Promise.all(ids.map(id => this.kill(id)))
  }
}
