import { randomUUID } from 'crypto'
import { EventEmitter } from 'events'

import {
  ClaudeSession,
  type ScreenSnapshot,
} from '../core/runtime/claudeSession.js'
import type { JsonlEntry } from '../core/runtime/jsonlTailer.js'

// SessionManager: a thin registry on top of ClaudeSession that lets the
// main process run N sessions in parallel. Every event every session
// emits is re-emitted here with the sessionId attached, so the Electron
// IPC forwarder can attach one listener per channel instead of N×channels.
//
// Why not just use a plain Map<id, ClaudeSession> and attach listeners
// directly from main/index.ts:
//   - main/index.ts would need to re-subscribe every time a session is
//     spawned, and unsubscribe on kill, doubling the bookkeeping.
//   - The forwarder would have to multiplex events from N sessions into
//     one IPC channel per event type anyway — the mux belongs here where
//     it's testable in isolation.
//
// All methods are sync-safe except spawn() which has to wait for the
// underlying ClaudeSession to initialize its PTY + JSONL watcher.

export type ManagerEvents = {
  started: [{ sessionId: string; projectDir: string }]
  'pty-data': [{ sessionId: string; data: string }]
  screen: [{ sessionId: string } & ScreenSnapshot]
  'jsonl-entry': [{ sessionId: string; entry: JsonlEntry; file: string }]
  'jsonl-error': [{ sessionId: string; error: Error }]
  exit: [{ sessionId: string; exitCode: number; signal?: number }]
}

export type SpawnOptions = {
  cwd: string
  cols?: number
  rows?: number
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

export class SessionManager extends EventEmitter {
  private readonly sessions = new Map<string, ClaudeSession>()

  /**
   * Spawn a new session and return its sessionId. Blocks until the PTY
   * is spawned and the JSONL watcher is attached — after this resolves
   * the caller can immediately start sending input via `write()`.
   */
  async spawn(options: SpawnOptions): Promise<string> {
    const sessionId = randomUUID()
    const session = new ClaudeSession({
      cwd: options.cwd,
      cols: options.cols ?? 120,
      rows: options.rows ?? 40,
      snapshotIntervalMs: 16,
    })

    // Wire every ClaudeSession event to a manager-level event with
    // sessionId attached. The main-process IPC forwarder listens once
    // here and dispatches to the renderer with the id included.
    session.on('started', ({ projectDir }) =>
      this.emit('started', { sessionId, projectDir }),
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

    this.sessions.set(sessionId, session)
    await session.start()
    return sessionId
  }

  /**
   * Write bytes to a session's PTY. Silently no-ops if the session
   * doesn't exist — this happens naturally if a session exits between
   * the renderer queueing input and the main process handling it.
   */
  write(sessionId: string, data: string): void {
    this.sessions.get(sessionId)?.write(data)
  }

  /** Resize a session's terminal + PTY. No-op if session doesn't exist. */
  resize(sessionId: string, cols: number, rows: number): void {
    this.sessions.get(sessionId)?.resize(cols, rows)
  }

  /**
   * Kill a session and remove it from the registry. Returns true if
   * the session existed and was killed.
   */
  async kill(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    await session.stop()
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
