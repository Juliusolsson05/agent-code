// ProviderConfig — split into renderer-safe and main-process parts.
//
// The renderer bundle can't import Node modules (node-pty, chokidar,
// fs). The main process can't import React components. So the config
// is two interfaces, each with its own registry.

import type { ComponentType } from 'react'
import type { SessionOptions, SessionInfo } from './session.js'

// Props the shell passes to every provider's TileLeaf.
export type TileLeafProps = {
  sessionId: string
  runtime: unknown
  focused: boolean
  onFocusRequest: () => void
  workspace: unknown
}

/**
 * Renderer-side config: only browser-safe imports.
 * Imported by TileTree, workspaceStore, etc.
 */
export type RendererProviderConfig = {
  id: string
  name: string
  /** Extract the assistant's in-progress text from a screen snapshot. */
  extractAssistantInProgress: (screen: string) => string
  /** The pane component the shell mounts inside TileTree. */
  TileLeaf: ComponentType<TileLeafProps>
}

/**
 * Main-process config: Node-only imports (session factories, fs).
 * Imported by sessionManager, IPC handlers.
 */
export type MainProviderConfig = {
  id: string
  name: string
  /** Factory: create a new session instance for this provider. */
  createSession: (opts: SessionOptions) => unknown
  /** List resumable sessions for a cwd. */
  listSessions: (cwd: string, limit: number) => Promise<SessionInfo[]>
  /** Resolve the on-disk project dir for a cwd. */
  getProjectDir: (cwd: string) => Promise<string>
}

/** Full config — union of both halves. Used in provider config files
 *  that export both sides. */
export type ProviderConfig = RendererProviderConfig & MainProviderConfig
