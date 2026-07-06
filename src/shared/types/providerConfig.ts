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
import type { SessionOptions, SessionInfo, AgentSession } from '@shared/types/session.js'
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

// ---------------------------------------------------------------------------
// Transcript-entry mapping capability (#394 phase 2b)
// ---------------------------------------------------------------------------

/**
 * Result of mapping ONE raw transcript line (Claude JSONL entry or
 * Codex rollout line) into feed entries.
 *
 * `entries` may be empty (Claude lines filtered by the conversation/
 * compact gate; Codex event_msg lines with no feed representation) or
 * carry multiple entries (Codex response_items that fan out).
 *
 * `historyMarker` is the provider's pagination marker for this line —
 * Claude: stable uuid (null for non-conversation lines); Codex:
 * synthesized timestamp:id marker (always present). Call sites own the
 * policy for WHEN to record it (bootstrap records the first, older-
 * pagination replaces conditionally).
 */
export type MappedTranscriptEntry = {
  entries: import('@shared/types/transcript.js').Entry[]
  historyMarker: string | null
}

/**
 * Provider-owned transcript-line mapper. Created fresh per ingestion
 * stream (one per live session, one per history chunk, one per
 * preview build).
 *
 * WHY an interface with a factory instead of a pure function: Codex's
 * mapping is stateful — a rolling turn cursor stamps entries with the
 * turn they belong to, updated/cleared by lines the mapper itself
 * sees. Claude's mapper is stateless and implements the cursor
 * methods as no-ops. The live-ingest site persists the cursor across
 * bursts via get/setTurnCursor; chunk-scoped sites just discard the
 * mapper.
 *
 * This capability is what killed the quadruplicated per-provider
 * mapping loops (live ingest / initial history / older history /
 * preview — see #394 §4.5, §9). A third provider implements ONE
 * mapper and every ingestion path picks it up from the registry.
 */
export type TranscriptEntryMapper = {
  map(raw: Record<string, unknown>): MappedTranscriptEntry
  getTurnCursor(): string | null
  setTurnCursor(id: string | null): void
}

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
  /**
   * Factory: create a new session instance for this provider.
   *
   * WHY the return is typed AgentSession (and not `unknown` as
   * before): the previous shape made every provider silently
   * responsible for matching an unwritten event/method contract.
   * sessionManager.spawn then cast to a structural AgentSessionLike
   * that only checked "can subscribe" — a provider that dropped
   * `screen`, misspelled `semantic-event`, or shipped a different
   * payload for `jsonl-entry` compiled fine and failed silently at
   * runtime as "the feature is just missing" (a top failure mode in
   * #394 §4).
   *
   * See @shared/types/session.ts for the AgentSession contract
   * (typed event map + optional capability methods). Widening for a
   * third provider now surfaces as a compile error inside the
   * provider, exactly where it can be fixed.
   */
  createSession: (opts: SessionOptions) => AgentSession
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
  /**
   * Provider-owned prompt delivery protocol (#394 phase 2c).
   *
   * WHY this is a capability and not inline branches: prompt delivery
   * disciplines are OPPOSITE between the two shipped providers —
   * Codex gates on TUI readiness BEFORE pasting and sends paste+Enter
   * as one atomic PTY write (its headless accounts the prompt as
   * submitted on the paste bytes); Claude pastes WITHOUT Enter, waits
   * for the `[Pasted text #N]` placeholder to prove the paste
   * committed, then sends Enter separately. The old inline
   * `if codex … if claude …` in MCP's submitPrompt meant a THIRD
   * provider fell through to a protocol-free paste+Enter with no
   * readiness gate and no confirmation (#394 §4.2) — it "worked"
   * exactly until it didn't, silently.
   *
   * The io bag deliberately passes the AgentSession plus a bound
   * write-with-liveness function rather than the SessionManager:
   * providers must not depend on the manager (dependency arrow), and
   * the typed optionals they need (awaitReadyForPrompt /
   * awaitPastePlaceholder) live on AgentSession since phase 2a.
   */
  deliverPrompt: (io: PromptDeliveryIo) => Promise<PromptDeliveryResult>
}

export type PromptDeliveryIo = {
  session: AgentSession
  /** Write raw bytes to the session PTY. Returns false when the
   *  session is gone — callers already treat that as delivery
   *  failure, so providers just propagate it. */
  write: (data: string) => boolean
  sessionId: string
  prompt: string
}

export type PromptDeliveryResult =
  | { ok: true }
  | { ok: false; message: string }

// The combined `ProviderConfig = RendererProviderConfig & MainProviderConfig`
// type used to live here. It was only ever used by
// `providers/<kind>/config.ts` files that implemented the full
// surface, which forced those files to import BOTH TileLeaf (React)
// AND ClaudeSession (Node). That cross-boundary import was the
// source of the renderer-in-node tsc cascade. Type removed; use the
// one-sided types above.
