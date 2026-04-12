// ProviderConfig — the contract between the shell and a provider.
//
// Each provider (Claude, Codex) exports one of these. The shell
// imports them through src/providers/registry.ts — never directly.
// This is the only coupling point between shell and provider code.
//
// The interface is deliberately thin: just entry points. Providers
// are complex internally (50+ custom commands, trust dialogs, slash
// pickers, etc.), but the shell doesn't know about any of that.
// If Claude needs a slash picker, Claude's TileLeaf renders it.
// The shell just mounts config.TileLeaf and gets out of the way.

import type { ComponentType } from 'react'
import type { SessionOptions, SessionInfo } from './session.js'

// Props the shell passes to every provider's TileLeaf. The provider
// composes these with its own internal state. `runtime` and
// `workspace` are typed as `unknown` here to avoid circular deps
// between shared/ and shell/ — providers cast internally.
export type TileLeafProps = {
  sessionId: string
  runtime: unknown
  focused: boolean
  onFocusRequest: () => void
  workspace: unknown
}

export type ProviderConfig = {
  /** Unique identifier stored in session metadata ('claude', 'codex'). */
  id: string
  /** Human-readable name for UI display. */
  name: string

  // --- Runtime (main process) ---
  /** Factory: create a new session instance for this provider. */
  createSession: (opts: SessionOptions) => unknown
  /** List resumable sessions for a cwd. */
  listSessions: (cwd: string, limit: number) => Promise<SessionInfo[]>
  /** Resolve the on-disk project dir for a cwd. */
  getProjectDir: (cwd: string) => Promise<string>

  // --- Parsing (renderer) ---
  /** Extract the assistant's in-progress text from a screen snapshot. */
  extractAssistantInProgress: (screen: string) => string

  // --- Renderer ---
  /** The pane component the shell mounts inside TileTree. */
  TileLeaf: ComponentType<TileLeafProps>
}
