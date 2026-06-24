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

import type { ComponentType, ReactNode } from 'react'
import type { SessionOptions, SessionInfo } from '@shared/types/session.js'
import type { AgentProviderKind } from '@shared/types/providerKind.js'
import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript.js'

export type TileLeafRelatedAgentTab = {
  sessionId: string
  relation: 'parent' | 'linked' | 'orchestration'
  label: string
  title: string
  kind: AgentProviderKind | 'terminal' | undefined
  placement: 'grid' | 'detached'
}

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
  /**
   * WHY these shell-chrome props live in the provider contract now:
   * TileTree has always passed them to the concrete in-repo TileLeaf, but the
   * public type claimed providers only received the bare pane identity/runtime
   * fields. That mismatch forced TileTree to widen the component with a local
   * cast, which hid the real call surface from any future provider pane.
   *
   * Keep the shapes structural and renderer-free here on purpose. Importing
   * `Workspace`, `SessionId`, or `GridRelatedAgentTab` from the renderer would
   * make this shared type drag renderer files into the node project again, the
   * exact boundary leak this file exists to prevent. The concrete renderer
   * types are assignable to these strings/records without coupling the halves.
   */
  ownerSessionId?: string
  relatedAgentTabs?: TileLeafRelatedAgentTab[]
  selectedRelatedSessionId?: string
  onSelectRelatedSession?: (sessionId: string) => void
}

/**
 * The shared provider config intentionally does not import `ConditionView`.
 *
 * WHY the value type is `unknown`: this file is imported by both node and
 * renderer projects to describe the provider registry shape. The actual
 * condition view contract is React-renderer-only and is enforced in
 * `registry.renderer.capabilities.ts`, where importing ConditionView is safe.
 * Keeping this shared boundary opaque prevents a provider capability from
 * pulling renderer condition modules into the main-process type graph again.
 */
export type RendererConditionViewRegistry = Record<string, unknown>

/**
 * Renderer-side config: only browser-safe imports.
 * Imported by TileTree, workspaceStore, etc.
 */
export type RendererProviderConfig = {
  /** Provider identity — constrained to the shared source of truth so a
   *  config can't be registered under an id the rest of the app doesn't
   *  recognise. */
  id: AgentProviderKind
  name: string
  /**
   * Provider-owned condition views.
   *
   * WHY this belongs on the renderer registry: the snapshot already carries a
   * provider id, and unknown providers should flow through the same throwing
   * registry lookup as panes. The old `provider === 'claude' ? A : B` in
   * ProviderConditionOutlet silently rendered every future provider with Codex
   * views. Keeping the views here makes the provider registry load-bearing for
   * one real renderer capability instead of another ad hoc binary fallback.
   */
  conditionViews: RendererConditionViewRegistry
  /**
   * Provider-owned committed transcript row dispatch.
   *
   * WHY `undefined` means "no provider opinion" but `null` means "render
   * nothing": generic rows are still the shared fallback for unknown Claude
   * tools, while Codex has a few result rows (notably spawn_agent join payloads)
   * whose correct UI is suppression. Collapsing both cases to `null` would make
   * it impossible for Block.tsx to distinguish "fall back" from "intentionally
   * consumed".
   */
  renderToolUse?: (block: ToolUseBlock) => ReactNode | undefined
  renderToolResult?: (
    block: ToolResultBlock,
    context: { sourceTool?: ToolUseBlock | null },
  ) => ReactNode | undefined
  /** The pane component the shell mounts inside TileTree. */
  TileLeaf: ComponentType<TileLeafProps>
}

/**
 * Main-process config: Node-only imports (session factories, fs).
 * Imported by sessionManager, IPC handlers.
 */
export type MainProviderConfig = {
  /** Provider identity — see RendererProviderConfig.id. */
  id: AgentProviderKind
  name: string
  /** Factory: create a new session instance for this provider. */
  createSession: (opts: SessionOptions) => unknown
  /** List resumable sessions for a cwd. */
  listSessions: (cwd: string, limit: number) => Promise<SessionInfo[]>
  /**
   * List resumable sessions without cwd scoping when a caller genuinely needs a
   * global debug/resume inventory.
   *
   * WHY this is optional and provider-owned: the normal app flow should prefer
   * `listSessions(cwd, limit)` so resume choices match the cwd Agent Code will
   * spawn in. The rendering-debug harness is different: it has no focused cwd
   * and needs a cross-provider inventory. Routing that exceptional path through
   * the main provider registry prevents IPC adapters from importing provider
   * storage walkers directly while still allowing Claude to keep its app-local
   * global walker until the package grows an equivalent API.
   */
  listAllSessions?: (limit: number) => Promise<SessionInfo[]>
  /** Resolve the on-disk project dir for a cwd. */
  getProjectDir: (cwd: string) => Promise<string>
  /**
   * Resolve the durable transcript file for a provider session id.
   *
   * WHY this is separate from getProjectDir: Claude's project dir is the
   * transcript directory itself, while Codex's "project dir" equivalent is a
   * global sessions root that must be searched by structured rollout filename.
   * Returning a path-level helper from the provider registry keeps shared
   * history loading from knowing which meaning each provider assigned to
   * `getProjectDir`.
   */
  resolveTranscriptPath: (cwd: string, providerSessionId: string) => Promise<string | null>
}

// The combined `ProviderConfig = RendererProviderConfig & MainProviderConfig`
// type used to live here. It was only ever used by
// `providers/<kind>/config.ts` files that implemented the full
// surface, which forced those files to import BOTH TileLeaf (React)
// AND ClaudeSession (Node). That cross-boundary import was the
// source of the renderer-in-node tsc cascade. Type removed; use the
// one-sided types above.
