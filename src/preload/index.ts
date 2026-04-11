import { contextBridge, ipcRenderer } from 'electron'

// Preload bridge — multi-session API.
//
// Every IPC channel is sessionId-scoped because the main process can
// now run N ClaudeSessions in parallel and needs to route messages to
// the right one. The renderer subscribes ONCE per event type and
// dispatches by sessionId in the callback — this avoids N×N listener
// storms as tabs and splits grow.
//
// Legacy note: the pre-tiling API had channels like `pty:screen`,
// `pty:input`, `pty:exit`. Those are all gone. The tile tree uses
// `session:*` channels that carry `{ sessionId, ... }` payloads.

export type JsonlEntry = Record<string, unknown>
export type ScreenSnapshot = { plain: string; markdown: string }

export type SessionStartedEvent = { sessionId: string; projectDir: string }
export type SessionScreenEvent = { sessionId: string } & ScreenSnapshot
export type SessionJsonlEntryEvent = {
  sessionId: string
  entry: JsonlEntry
  file: string
}
export type SessionJsonlErrorEvent = { sessionId: string; message: string }
export type SessionExitEvent = {
  sessionId: string
  exitCode: number
  signal?: number
}

type Unsub = () => void

/**
 * Helper to register an IPC listener and return an unsubscriber that
 * detaches it. Keeps the api surface below tidy.
 */
function subscribe<T>(channel: string, cb: (payload: T) => void): Unsub {
  const listener = (_evt: unknown, payload: T) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  // --- Session lifecycle ---
  spawnSession: (options: {
    cwd: string
    cols?: number
    rows?: number
  }): Promise<string> => ipcRenderer.invoke('session:spawn', options),

  killSession: (sessionId: string): Promise<boolean> =>
    ipcRenderer.invoke('session:kill', sessionId),

  // --- Per-session I/O ---
  sendInput: (sessionId: string, data: string): Promise<void> =>
    ipcRenderer.invoke('session:input', sessionId, data),

  resize: (sessionId: string, cols: number, rows: number): Promise<void> =>
    ipcRenderer.invoke('session:resize', sessionId, cols, rows),

  // --- Session events (subscribe once; dispatch by sessionId in the callback) ---
  onSessionStarted: (cb: (e: SessionStartedEvent) => void): Unsub =>
    subscribe('session:started', cb),

  onSessionScreen: (cb: (e: SessionScreenEvent) => void): Unsub =>
    subscribe('session:screen', cb),

  onSessionJsonlEntry: (cb: (e: SessionJsonlEntryEvent) => void): Unsub =>
    subscribe('session:jsonl-entry', cb),

  onSessionJsonlError: (cb: (e: SessionJsonlErrorEvent) => void): Unsub =>
    subscribe('session:jsonl-error', cb),

  onSessionExit: (cb: (e: SessionExitEvent) => void): Unsub =>
    subscribe('session:exit', cb),

  // --- Workspace persistence ---
  // Main just does the disk I/O. The renderer decides the JSON shape.
  loadWorkspace: (): Promise<string | null> =>
    ipcRenderer.invoke('workspace:load'),

  saveWorkspace: (json: string): Promise<void> =>
    ipcRenderer.invoke('workspace:save', json),

  defaultCwd: (): Promise<string> =>
    ipcRenderer.invoke('workspace:defaultCwd'),

  // --- Path expansion (used by the new-tab path modal) ---
  expandCwd: (
    raw: string,
  ): Promise<{ ok: true; path: string } | { ok: false; error: string }> =>
    ipcRenderer.invoke('fs:expandCwd', raw),
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
