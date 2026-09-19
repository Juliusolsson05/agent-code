import type {
  SessionId,
  TabId,
  WorkspaceState,
} from '@renderer/workspace/types'

// Canonical session-set queries for the workspace.
//
// WHY this file exists, and what changed under it (#992):
//
// The workspace used to have FIVE session-placement buckets (grid via
// tile-tree leaves, detached via state.detachedSessions, buried via
// state.buried, plus pinned + focused as cross-cutting attributes). Asking
// "which sessions are in project X?" without composing the right subset was
// the recurring root cause of PRs #37, #39, #44, #45, #46, #58, #59, #69,
// #83, and issue #104: surfaces reached for `tab.root` directly and forgot
// that detached agents also belonged to the tab via `projectTabId`. This
// file was the contract that composed the union once.
//
// There is no union any more. A session belongs to a project because its own
// row says so (`SessionMeta.projectId`), and its position is its own
// `joinedAt`. The contract this file holds is therefore smaller but not
// gone: callers still ask membership questions HERE, so that the day a
// second fact affects membership or order there is one place to put it —
// which is the lesson of those ten PRs, not the five buckets themselves.
//
// SCOPE: these queries answer "membership" questions. They do NOT decide
// which session a command targets — that is the focused lane's occupant,
// resolved by `commandTargetSessionId` in
// `hook/selectors/commandTargetSessionId.ts`.

type PoolView = Pick<WorkspaceState, 'sessions'>

/**
 * The project a session belongs to, or undefined when the session is unknown
 * or has not been filed yet (the instant between `spawn` writing a row and
 * its caller stamping membership).
 */
export function projectIdOf(state: PoolView, sessionId: SessionId): TabId | undefined {
  return state.sessions[sessionId]?.projectId
}

/**
 * Every session owned by this project, in index order.
 *
 * Order: ascending `joinedAt`, ties broken by the `sessions` map's insertion
 * order (Array.prototype.sort is stable, and Object.keys preserves insertion
 * order for string keys). A row with no `joinedAt` sorts as 0 — first —
 * which is where a migrated v2 tree leaf belongs and is harmless for a row
 * that is mid-spawn.
 *
 * Includes every session kind: terminals and extension views are pool
 * citizens like agents. Agent-only surfaces must filter by kind at their own
 * boundary instead of baking that policy into membership.
 */
export function resolveTabSessions(
  state: PoolView,
  tabId: TabId,
): SessionId[] {
  return Object.keys(state.sessions)
    .filter(id => state.sessions[id]?.projectId === tabId)
    .sort((a, b) => (state.sessions[a]?.joinedAt ?? 0) - (state.sessions[b]?.joinedAt ?? 0))
}

/**
 * Every session in the workspace, across every project.
 *
 * Used by surfaces that genuinely operate globally: cross-project pickers,
 * global telemetry, the "most recent session" finder. For per-project
 * questions use `resolveTabSessions` instead.
 *
 * The helper exists for discoverability, so callers don't reach for
 * `Object.keys(state.sessions)` directly and bypass any future filtering or
 * ordering rules this layer adds.
 */
export function resolveAllSessions(state: PoolView): SessionId[] {
  return Object.keys(state.sessions)
}

// `isDetached(state, id)` lived here until #992. "Detached" meant "owned by a
// detachedSessions record rather than a tile leaf"; with neither structure
// there is nothing for it to distinguish. Callers that really meant "has no
// backend right now" read the session's runtime (`processStatus`) instead.

/**
 * Projects that currently hold a session whose working directory is exactly
 * `cwd`, in project order.
 *
 * WHY this is the definition of "this project is already open" (#913): a
 * project carries no directory of its own; its title is the basename chosen
 * at creation and the only durable link to a folder is the cwd of the
 * sessions it holds. The operator capability `projects.open` has used this
 * rule since it shipped; the path picker shares it so ⌘T stops minting a
 * fresh project for a folder that is already open. Exact match on purpose: a
 * worktree is a different directory, and Merge Project Tabs is the tool for
 * folding worktree projects together.
 *
 * The comparison is on the cwd string as stored. `expandCwd` resolves `~`
 * and trailing slashes but not symlinks, so a session spawned through
 * `projects.open` with a symlinked spelling of the same folder is a different
 * directory here — consistent with how `projects.open` itself has always
 * matched, and cheaper than a realpath round-trip per keystroke in the picker.
 */
export function findTabsHoldingDirectory(
  state: WorkspaceState,
  cwd: string,
): WorkspaceState['tabs'] {
  return state.tabs.filter(tab =>
    resolveTabSessions(state, tab.id).some(id => state.sessions[id]?.cwd === cwd),
  )
}
