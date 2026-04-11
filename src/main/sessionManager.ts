import { randomUUID } from 'crypto'
import { EventEmitter } from 'events'

import {
  ClaudeSession,
  type ScreenSnapshot,
} from '../core/runtime/claudeSession.js'
import { TerminalSession } from '../core/runtime/terminalSession.js'
import type { JsonlEntry } from '../core/runtime/jsonlTailer.js'

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

export type SessionKind = 'claude' | 'terminal'

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
  | { kind: 'terminal'; session: TerminalSession }

export class SessionManager extends EventEmitter {
  private readonly sessions = new Map<string, RegistryEntry>()

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

    // kind === 'terminal'
    const session = new TerminalSession({
      cwd: options.cwd,
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
    })

    // Terminal sessions only emit started / data / exit. The 'data'
    // event carries raw PTY bytes for xterm.js on the renderer side;
    // we forward it on a dedicated 'terminal-data' channel so the
    // renderer can route it straight to xterm without the code path
    // for Claude's structured events getting involved.
    session.on('started', () =>
      this.emit('started', { sessionId, kind, projectDir: undefined }),
    )
    session.on('data', data =>
      this.emit('terminal-data', { sessionId, data }),
    )
    session.on('exit', ({ exitCode, signal }) => {
      this.emit('exit', { sessionId, exitCode, signal })
      this.sessions.delete(sessionId)
    })

    this.sessions.set(sessionId, { kind: 'terminal', session })
    await session.start()
    return sessionId
  }

  /**
   * Write bytes to a session's PTY. Silently no-ops if the session
   * doesn't exist — this happens naturally if a session exits between
   * the renderer queueing input and the main process handling it.
   */
  write(sessionId: string, data: string): void {
    this.sessions.get(sessionId)?.session.write(data)
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
