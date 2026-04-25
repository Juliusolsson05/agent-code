// ProviderConfig — split into renderer-safe and main-process parts.
//
// The renderer bundle can't import Node modules (node-pty, chokidar,
// fs). The main process can't import React components. So the config
// is two interfaces, each with its own registry. Hard split — there
// is NO combined `ProviderConfig` type. A previous version of this
// file exported one, and also shipped `providers/<kind>/config.ts`
// files that implemented it by importing both `ClaudeSession`
// (Node-only) and `TileLeaf` (React-only). That was the bridge that
// caused the node tsconfig to walk into renderer files and emit the
// JSX-not-set cascade across ~500 lines of error output. Both halves
// and their registries are now strictly separate; `registry.main.ts`
// builds MainProviderConfig, `registry.renderer.ts` builds
// RendererProviderConfig, and nothing re-joins them.

import type { ComponentType } from 'react'
import type { SessionOptions, SessionInfo } from '@shared/types/session.js'

// Props the shell passes to every provider's TileLeaf.
export type TileLeafProps = {
  sessionId: string
  runtime: unknown
  focused: boolean
  paneLabel?: string
  onFocusRequest: () => void
  workspace: unknown
  showStatusMode?: boolean
  showWorktreeBadges?: boolean
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

// The combined `ProviderConfig = RendererProviderConfig & MainProviderConfig`
// type used to live here. It was only ever used by
// `providers/<kind>/config.ts` files that implemented the full
// surface, which forced those files to import BOTH TileLeaf (React)
// AND ClaudeSession (Node). That cross-boundary import was the
// source of the renderer-in-node tsc cascade. Type removed; use the
// one-sided types above.
