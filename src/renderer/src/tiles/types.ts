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
//     in that tab's root.

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

export type SessionMeta = {
  /** cwd the session was spawned with — needed to respawn on relaunch. */
  cwd: string
  /** Optional user-provided or derived label shown in tab titles. */
  title?: string
}

export type WorkspaceState = {
  tabs: Tab[]
  activeTabId: TabId
  /**
   * Per-session metadata. Every leaf's sessionId MUST exist here or the
   * tree is invalid. Orphaned entries (a session that's no longer in any
   * tree) get garbage collected by assertInvariants.
   */
  sessions: Record<SessionId, SessionMeta>
}

export const RATIO_MIN = 0.1
export const RATIO_MAX = 0.9
export const RATIO_DEFAULT = 0.5
