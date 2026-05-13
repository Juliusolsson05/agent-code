import { collectLeaves } from '@renderer/workspace/tile-tree/treeOps'
import type {
  SessionId,
  TabId,
  WorkspaceState,
} from '@renderer/workspace/types'

// Canonical session-set queries for the workspace.
//
// WHY this file exists: the workspace has FIVE session-placement
// buckets (grid via tile-tree leaves, detached via
// state.detachedSessions, buried via state.buried, plus pinned +
// focused as cross-cutting attributes). Asking "which sessions are
// in tab X?" without composing the right subset has been the
// recurring root cause of PRs #37, #39, #44, #45, #46, #58, #59,
// #69, #83, and issue #104. Every patch caught an instance; none
// caught the pattern.
//
// The pattern is broken because surfaces reach for `tab.root`
// directly (via collectLeaves) without remembering that detached
// agents also "belong" to the tab via projectTabId. This file is
// the contract: callers should ask their question through one of
// these functions, and the implementation handles the union
// correctly once. Adding a new surface that walks the grid directly
// is — per the resolver-discipline CI check — a build failure.
//
// SCOPE: these queries answer "membership" questions ("which
// sessions are in this tab?"). They do NOT decide which session a
// command targets — that's the focus-resolution concern, handled by
// `commandTargetSessionId` in
// `hook/selectors/commandTargetSessionId.ts`, which already
// correctly composes Dispatch focus → grid focus.

/**
 * Every live session owned by this tab, regardless of placement.
 *
 * Composes:
 *   - grid leaves (collectLeaves(tab.root)) — the visible tile tree
 *   - detached agents whose `projectTabId === tabId` and whose
 *     surface === 'dispatch' — Dispatch Mode agents that live
 *     outside the grid but belong to this project
 *
 * Excludes terminals from the detached side because terminals are
 * always grid by design (Dispatch never holds a terminal).
 *
 * Excludes `state.buried` deliberately: burying a pane is the
 * user's signal to put it away. Surfaces that ask "what's in this
 * tab right now" should not surface buried items as if they were
 * active. The unbury / undo flow is the place to walk
 * `state.buried`.
 *
 * Order: grid leaves first (in depth-first tile-tree order), then
 * detached agents oldest-detached-first (matches the existing UI
 * ordering documented in
 * `dispatchSelectors.detachedDispatchSessionIdsForTab`).
 */
export function resolveTabSessions(
  state: WorkspaceState,
  tabId: TabId,
): SessionId[] {
  const tab = state.tabs.find(t => t.id === tabId)
  const gridIds = tab ? collectLeaves(tab.root) : []
  const detachedIds = Object.values(state.detachedSessions)
    .filter(entry => (
      entry.surface === 'dispatch' &&
      entry.projectTabId === tabId &&
      state.sessions[entry.sessionId] !== undefined &&
      state.sessions[entry.sessionId]?.kind !== 'terminal'
    ))
    .sort((a, b) => a.detachedAt - b.detachedAt)
    .map(entry => entry.sessionId)
  // De-dupe defensively — the types-level invariant says a session
  // is in the tile tree OR detachedSessions, never both, but a
  // future bug that violates that invariant should not silently
  // produce duplicates in callers' filter/count loops.
  const seen = new Set<SessionId>()
  const out: SessionId[] = []
  for (const id of [...gridIds, ...detachedIds]) {
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/**
 * Every live session in the workspace, across every tab and every
 * placement.
 *
 * Used by surfaces that genuinely operate globally: cross-tab
 * pickers, global telemetry, the "most recent session" finder. For
 * per-tab questions use `resolveTabSessions` instead — passing an
 * `activeTabId` filter on top of this is a code smell that usually
 * means the caller wanted `resolveTabSessions` to begin with.
 *
 * The `state.sessions` map already includes every live session by
 * definition. Iterating it directly is the cleanest implementation;
 * the helper exists for discoverability (so callers don't reach for
 * `Object.keys(state.sessions)` directly and bypass any future
 * filtering or ordering rules this layer adds).
 */
export function resolveAllSessions(state: WorkspaceState): SessionId[] {
  return Object.keys(state.sessions)
}

/**
 * Is this session currently detached (i.e. lives in
 * `state.detachedSessions`, not in any tab's tile tree)?
 *
 * WHY this helper exists rather than letting callers index
 * `state.detachedSessions[sessionId]` directly: that subscript is the
 * exact pattern the resolver-discipline CI check flags. Some commands
 * legitimately need to ask "is this thing detached?" (e.g. the
 * attach-to-grid command's when-guard, which should only show for
 * detached agents). Routing through a named query keeps the API
 * surface honest — the violating pattern stays in the resolver layer
 * where it's defined and reviewed.
 *
 * Returns `false` for unknown session ids — callers should always
 * pair this with a `state.sessions[id]` existence check if they need
 * to distinguish "detached" from "doesn't exist."
 */
export function isDetached(state: WorkspaceState, sessionId: SessionId): boolean {
  return state.detachedSessions[sessionId] !== undefined
}
