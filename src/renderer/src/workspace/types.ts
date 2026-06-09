import type { BuiltInMcpDomain } from '@mcp/shared/types'

// Tile tree data model.
//
// Design constraints (captured during brainstorming with the user):
//   1. Tabs on top, binary-split tiles inside each tab (iTerm2/tmux style).
//   2. New TAB prompts the user for a cwd. New SPLIT inherits the cwd of
//      the pane you split from.
//   3. Auto-restore on launch: the workspace serializes to disk on every
//      mutation (debounced) and rehydrates on next launch.
//   4. Every session is keyed by a SessionId that main spawns — the
//      renderer never mints them itself.
//
// Tree invariants (enforced by assertInvariants in workspaceStore):
//   - Every leaf's sessionId appears in `sessions`.
//   - Splits always have exactly two children. Closing one side collapses
//     the split into the surviving sibling.
//   - `ratio` is clamped to [0.1, 0.9] so no pane can become invisibly small.
//   - `focusedSessionId` on each tab references a leaf that actually exists
//     in that tab's root. Detached sessions intentionally do NOT use this
//     field for focus; mode-specific surfaces carry their own selection.

export type SessionId = string
export type TabId = string

export type SplitDirection = 'vertical' | 'horizontal'

/**
 * Vertical split = divider runs top-to-bottom, `a` is left, `b` is right.
 * Horizontal split = divider runs left-to-right, `a` is top, `b` is bottom.
 * We deliberately use a/b instead of left/right so the direction flip
 * between vertical and horizontal doesn't mislead.
 */
export type TileNode =
  | { type: 'leaf'; sessionId: SessionId }
  | {
      type: 'split'
      direction: SplitDirection
      ratio: number
      a: TileNode
      b: TileNode
    }

export type Tab = {
  id: TabId
  title: string
  root: TileNode
  focusedSessionId: SessionId
}

/**
 * Which kind of backend a session drives.
 *
 *   'claude'   — a Claude Code child process. The pane renders the
 *                full Agent Code UI (feed, composer, slash picker, …)
 *                driven by the JSONL transcript + headless terminal
 *                screen scrape.
 *   'terminal' — a plain shell child process. The pane renders an
 *                xterm.js instance that receives raw PTY bytes and
 *                forwards keystrokes back. VS Code-style integrated
 *                terminal with no Agent Code chrome.
 *
 * Persisted in SessionMeta so a reload restores each pane to the
 * right component. Absent (= undefined) in pre-terminal workspace.json
 * blobs, treated as 'claude' at load time.
 */
export type SessionKind = 'claude' | 'codex' | 'terminal'

export type SessionMeta = {
  /** cwd the session was spawned with — needed to respawn on relaunch. */
  cwd: string
  /** Optional user-provided or derived label shown in tab titles. */
  title?: string
  /**
   * Which backend runs in this pane. Defaults to 'claude' when
   * absent so pre-terminal workspace.json blobs keep working — the
   * tile tree is always there, but old entries never carried kind.
   */
  kind?: SessionKind
  /**
   * CC's own session UUID (distinct from Agent Code's SessionId which is
   * a per-launch routing key). Captured from the `sessionId` field on
   * the first JSONL entry that lands for this session, and persisted
   * to disk so we can pass `--resume <uuid>` on the next launch and
   * rehydrate the conversation history, tool calls, and everything
   * else CC tracks in its transcript file.
   *
   * Without this, a workspace reload / hot-reload / app crash lands
   * the user in a new blank session every time — the tile tree comes
   * back but every pane's conversation is gone, which was causing
   * real frustration during development. See the load path in
   * workspaceStore.rehydrate() and the jsonl-entry handler that
   * captures it.
   *
   * Only meaningful for kind === 'claude'. Terminal sessions don't
   * have a JSONL transcript so there's nothing to resume; a reload
   * just spawns a fresh shell in the same cwd.
   */
  providerSessionId?: string
  /**
   * For tmux-backed terminals (P1): the registry-managed tmux
   * session name. Captured from the spawn IPC response and passed
   * back as `recoverTmuxName` on subsequent launches so the same
   * tmux session is re-attached instead of respawned. Without this,
   * persistence wouldn't work — the renderer would have no way to
   * tell main "this old session is the one I want."
   *
   * Undefined for direct-PTY terminals (when tmux isn't available)
   * and for agent sessions (P3 may extend this; not in P1).
   */
  tmuxName?: string
  /**
   * Set on a "Linked Agent" — an agent spawned via the Linked Agent
   * command with another agent as its parent. Two consequences:
   *
   *  1. Dispatch list: the linked agent renders indented directly
   *     under its parent's row (see buildDispatchGroups) instead of
   *     at the bottom of the tab group like an ordinary detached
   *     dispatch agent.
   *  2. Lifecycle: closing the parent session cascade-closes every
   *     session that names it here (see closeLinkedChildren in
   *     pane.ts). The link is the child's property — the parent
   *     holds no list — so the cascade is a scan of `sessions`.
   *
   * Absent for every ordinary agent. The id points at another
   * session in the same workspace; if that session is already gone
   * the field is simply inert (the child becomes a normal top-level
   * dispatch row). We deliberately do NOT chain — a linked agent
   * created off another linked agent points at the SAME top-level
   * parent, so the depth is always at most one.
   */
  linkedParentId?: SessionId
  /**
   * Set on an agent created by the Orchestration MCP server.
   *
   * WHY this is intentionally separate from `linkedParentId`:
   * linked agents are a user-facing manual affordance with existing Dispatch
   * indentation and cascade-close semantics. Orchestration agents are created
   * programmatically by an MCP tool and need their own lifecycle, grouping, and
   * future controls. Reusing `linkedParentId` would make the first
   * implementation look convenient while quietly coupling two different
   * product concepts; future "show orchestration run", "review worker diff",
   * or "stop this run" features would then inherit linked-agent behavior by
   * accident.
   */
  orchestrationParentId?: SessionId
  orchestrationRootId?: SessionId
  orchestrationRunId?: string
  orchestrationRole?: string
  /**
   * True when an orchestration child was spawned from a duplicated provider
   * transcript rather than a blank conversation.
   *
   * WHY this is persisted on the child instead of only returned from the
   * create call:
   * follow-up MCP prompts and Dispatch status views need to know whether the
   * child's provider history came from the parent. The clone itself is already
   * independent on disk; these ids are explanatory metadata for handoff
   * prompts and debugging, not authority to mutate the parent transcript.
   */
  inheritedParentContext?: boolean
  inheritedParentProviderSessionId?: string
  inheritedProviderSessionId?: string
  /**
   * Durable marker that the first orchestration handoff prompt has already
   * been delivered to this child.
   *
   * WHY this cannot live only in main's OrchestrationBridge:
   * the bridge's prompt-delivery map is intentionally short-lived coordination
   * state. Workspace sessions survive app restarts and metadata pruning; the
   * fact that the child already received its identity/handoff guard must
   * survive with the child, otherwise the next `send_prompt` after restart
   * would inject a second bootstrap block mid-conversation.
   */
  orchestrationBootstrapPromptDelivered?: boolean
  /**
   * Built-in MCP domains this agent should receive when it is spawned.
   *
   * WHY this is session metadata, not only a transient spawn option:
   * enabling an Agent Code MCP server is a property of the live agent
   * contract. Reloading dangerous-mode settings, restoring a workspace,
   * switching focus, or duplicating UI placement should not silently strip
   * those tools from the provider process. Persisting the domain names keeps
   * the renderer as the source of truth for "this pane is MCP-augmented" while
   * the main process owns the short-lived URL/token material.
   */
  builtInMcpDomains?: BuiltInMcpDomain[]
}

export type BuriedPaneRecord = {
  /** Stable id for picker actions; same as sessionId for now. */
  id: string
  /** The live hidden session. Remains running while buried. */
  sessionId: SessionId
  /** Persisted session metadata so reload/revive can describe it. */
  sessionMeta: SessionMeta
  buriedAt: number
  /** Where the pane came from before it was removed from the tree. */
  sourceTabId: TabId
  sourceTabTitle: string
  sourceTabIndex: number
  /** Placement hint captured from the parent split when available. */
  direction?: SplitDirection
  ratio?: number
  side?: 'a' | 'b'
  /** Anchor leaf from the surviving sibling subtree, if any. */
  siblingLeafId?: SessionId
  /** Optional user note captured when the pane was buried. */
  note?: string
}

export type DetachedSessionSurface = 'dispatch'

export type DetachedSessionRecord = {
  /** The live session that is intentionally not placed in any tile tree. */
  sessionId: SessionId
  /**
   * Which non-grid surface owns the session right now.
   *
   * WHY this says "surface" instead of "backlog": the important model
   * decision is that sessions can be live without grid placement. Dispatch is
   * the first consumer, but the shape should still scale to future surfaces
   * without pretending those sessions are children of Dispatch Mode itself.
   */
  surface: DetachedSessionSurface
  /**
   * Project affinity, not hierarchy. The session is detached from the grid,
   * but it still needs a project tab for grouping, cwd defaults, terminal
   * selection, and project/global filtering in Dispatch Mode.
   */
  projectTabId: TabId
  projectTabTitle: string
  projectTabIndex: number
  detachedAt: number
}

/**
 * One lane in a Tiled Dispatch layout. lanes[0] is always the full index
 * lane; lanes[1..] are compact mini-list + agent-view lanes.
 */
export type DispatchLane = {
  /**
   * Session shown in this lane. Undefined => empty lane (renders a
   * lane-local "select an agent" prompt). On re-entry/rehydrate a lane
   * whose session no longer exists is reset to undefined and re-filled.
   *
   * The SAME sessionId may legitimately appear in more than one lane — the
   * earlier one-session-per-lane restriction was dropped because greying out
   * an agent just because it's open elsewhere is a confusing UX. When a
   * session is duplicated across lanes, the views MIRROR: Claude/Codex agent
   * views mirror for free (every TileLeaf reads the same per-session runtime
   * from the store and writes input keyed by sessionId, so feed + composer
   * reflect in all of them). Terminals are the one exception — their xterm
   * attach is currently single-attacher, so a duplicated TERMINAL only fully
   * mirrors once terminal multi-attach (ref-counted attach + PTY broadcast)
   * lands in its own follow-up. Until then, a duplicated terminal's second
   * view may not stream; agents are unaffected.
   */
  selectedSessionId?: SessionId
}

export type TiledDispatchState = {
  /** Tile count, clamped 1..10. lanes[0] is the index lane. */
  lanes: DispatchLane[]
  /**
   * Lane index that currently owns keyboard selection (arrows / cmd+N).
   * Switching the focused lane must never change another lane's
   * selection — that's the whole point of per-lane independence.
   * Defaults to 0 (the index lane).
   */
  focusedLane: number
  /**
   * Column widths. Index 0 is the pinned index lane's fraction of the whole
   * row (clamped 0.1..0.4 in the layout). Indices 1..N are relative weights
   * for the N agent-view lane units sharing the remaining width (normalized
   * on read; absolute scale irrelevant). Absent => even distribution. Reset
   * to undefined on tile-count change because a weight array sized for the
   * old lane count would mis-lay-out the new set. (See TiledDispatchLayout's
   * column-width convention comment, which is the load-bearing spec.)
   */
  ratios?: number[]
}

export type DispatchModeState = {
  scope: 'project' | 'global'
  /**
   * Dispatch Mode selection is separate from grid focus. Reusing
   * Tab.focusedSessionId for detached rows would violate the tile-tree
   * invariant above and make every normal grid command capable of targeting a
   * non-leaf session. Keep this mode-local so exiting Dispatch never leaves the
   * grid in an impossible focus state.
   */
  focusedSessionId?: SessionId
  /**
   * Present => render the multi-lane TiledDispatchLayout instead of the
   * classic single-agent layout. Lives inside dispatchMode (which is
   * already persisted to workspace.json) so lanes / focusedLane / ratios
   * survive reloads for free. Absent => classic Dispatch (unchanged).
   */
  tiled?: TiledDispatchState
  // HISTORICAL: a `terminalVisible: boolean` flag used to live here. It
  // was replaced by the global `settings.dispatchProjectTerminal` toggle
  // because the per-session flag re-defaulted to ON every time dispatch
  // was re-entered, producing the "I turned it off but it's back" bug.
  // Old workspace.json files may still carry the field; it is now ignored
  // (TypeScript drops unknown properties at runtime on shape coercion).
}

export type WorkspaceState = {
  tabs: Tab[]
  activeTabId: TabId
  /**
   * Dispatch Mode is part of the workspace layout, not a global user
   * preference. Persisting it here means a reload preserves the user's
   * command-center view for this project while other workspaces can keep
   * using the grid.
   */
  dispatchMode: DispatchModeState | null
  /**
   * Per-session metadata. Every live session MUST exist here. Grid-placed
   * sessions are referenced from tab roots; detached sessions are referenced
   * from detachedSessions. A session should never be in both places.
   */
  sessions: Record<SessionId, SessionMeta>
  /** Live sessions that intentionally have no tile-tree placement. */
  detachedSessions: Record<SessionId, DetachedSessionRecord>
  /** Hidden-but-live sessions removed from the visible layout. */
  buried: BuriedPaneRecord[]
  /**
   * Ordered list of session IDs the user has explicitly pinned to the
   * top of the dispatch list. ORDER MATTERS — `pinnedSessionIds[0]`
   * renders at the top of the Pinned section. The modal commits via
   * setPinnedSessionIds, which preserves caller order (the Space-toggle
   * sequence in the modal).
   *
   * Pinned sessions are ALWAYS visible in the Pinned section
   * regardless of dispatch scope (project vs global) — the whole
   * point of pins is that they survive the scope toggle. To keep the
   * cross-project view readable, each pinned row in
   * DispatchAgentList renders a small project chip (tab letter +
   * project basename). See dispatchSelectors.buildPinnedDispatchRows.
   *
   * Sessions that disappear from `sessions` are dropped at render
   * (buildPinnedDispatchRows skips missing ids) and at save time
   * (useAutoSave filters against the pruned session map) so a killed
   * session can never linger in the Pinned section as a phantom row
   * or in workspace.json as a stale entry.
   *
   * Terminals are never pinned: they're per-tab infrastructure, not
   * a unit the user "pins to favorites." setPinnedSessionIds rejects
   * terminal session ids defensively, and the modal filters them out
   * of its candidate row list.
   */
  pinnedSessionIds: SessionId[]
}

export const RATIO_MIN = 0.1
export const RATIO_MAX = 0.9
export const RATIO_DEFAULT = 0.5
