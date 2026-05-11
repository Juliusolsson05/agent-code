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
 *                full cc-shell UI (feed, composer, slash picker, …)
 *                driven by the JSONL transcript + headless terminal
 *                screen scrape.
 *   'terminal' — a plain shell child process. The pane renders an
 *                xterm.js instance that receives raw PTY bytes and
 *                forwards keystrokes back. VS Code-style integrated
 *                terminal with no cc-shell chrome.
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
   * CC's own session UUID (distinct from cc-shell's SessionId which is
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
}

export const RATIO_MIN = 0.1
export const RATIO_MAX = 0.9
export const RATIO_DEFAULT = 0.5
