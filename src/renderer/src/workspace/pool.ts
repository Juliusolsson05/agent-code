import { clearTiledLaneSessions, scrubGridRowMetadata } from '@renderer/workspace/dispatch/tiledDispatchSelectors'
import type {
  SessionId,
  SessionMeta,
  TabId,
  WorkspaceState,
} from '@renderer/workspace/types'

// ---------------------------------------------------------------------------
// Write-side helpers for the fleet pool (#992).
//
// WHY these are functions and not literals at each call site: before the
// unified layout, "file this new session under that project" was a hand-built
// `DetachedSessionRecord` literal repeated at six spawn sites, and "remove
// this session" was a different hand-written sequence in each of four close
// paths (delete the row, delete the detached record, collapse the tree,
// maybe promote a survivor, clear lanes, maybe remove the tab). Two of those
// close paths disagreed for months. Membership is one field now, which makes
// the literal tempting again — and the point of this file is that the NEXT
// fact a filing or a removal has to maintain gets added in one place.
//
// Read-side questions live in queries.ts.
// ---------------------------------------------------------------------------

/**
 * File `sessionId` under `projectId`: stamp its membership and its place at
 * the END of that project's index.
 *
 * Call it in the same `setState` that makes the session visible anywhere. The
 * row itself is written earlier by `spawn`; until this runs the session is
 * un-filed metadata — no index lists it and autosave would drop it, which is
 * the right outcome for a spawn whose caller bailed out.
 *
 * `joinedAt` defaults to now. Pass the predecessor's value when the session
 * REPLACES another (reload, provider switch, undo) so the row keeps its place
 * instead of jumping to the bottom of the list.
 *
 * Returns the same map when the session does not exist, so a caller racing a
 * kill cannot resurrect a row.
 */
export function fileSessionInProject(
  sessions: Record<SessionId, SessionMeta>,
  sessionId: SessionId,
  projectId: TabId,
  joinedAt: number = Date.now(),
): Record<SessionId, SessionMeta> {
  const meta = sessions[sessionId]
  if (!meta) return sessions
  return { ...sessions, [sessionId]: { ...meta, projectId, joinedAt } }
}

/**
 * The membership a successor should inherit from the session it replaces.
 * Spread it into the successor's row. Empty when the predecessor is unknown,
 * so the caller's own filing (or the ownership prune) decides instead of a
 * stale guess.
 */
export function inheritedMembership(
  predecessor: SessionMeta | undefined,
): Pick<SessionMeta, 'projectId' | 'joinedAt'> {
  if (!predecessor?.projectId) return {}
  return {
    projectId: predecessor.projectId,
    ...(predecessor.joinedAt !== undefined ? { joinedAt: predecessor.joinedAt } : {}),
  }
}

/**
 * Remove sessions from the workspace, and every project they leave empty.
 *
 * This is the WHOLE removal: rows out of the pool, their lanes emptied, their
 * pins dropped, and any project with no session left removed with them.
 *
 * WHY a project is removed when its last session goes: a project owns nothing
 * (U4) and has no directory of its own — its only content is its sessions. An
 * empty one would be a header over an empty list with no way to put anything
 * in it except ⌘T, which creates a project anyway. v2 had the same rule in a
 * different costume: a tab whose tree emptied and had no detached row to
 * promote was removed.
 *
 * What is deliberately NOT done:
 *  - A lane that showed a removed session goes EMPTY. It is never refilled
 *    with a neighbour (#681) and never removed — the user shaped the stage,
 *    and closing agents must not reshape it.
 *  - `activeTabId` moves only if the active project was removed, and then to
 *    its previous neighbour (the list-UI convention: the cursor trails a
 *    deletion). A close issued from a background surface (Agent Activity,
 *    Close Old Agents, automation) must not yank the user elsewhere.
 *
 * `alsoIfEmpty` names projects to remove if nothing is left in them even
 * though this call removed none of their sessions — a project whose last
 * session was already gone by the time its Close Tab commit ran. It is NEVER
 * a force: a project that still holds a session survives, because removing it
 * would orphan that session's backend (a row is deleted here, a process is
 * not — killing is the caller's job, done BEFORE this commit).
 */
export function workspaceWithoutSessions(
  prev: WorkspaceState,
  removedSessionIds: Iterable<SessionId>,
  alsoIfEmpty: Iterable<TabId> = [],
): WorkspaceState {
  const removed = new Set(removedSessionIds)
  const sessions: Record<SessionId, SessionMeta> = {}
  let touched = false
  for (const [id, meta] of Object.entries(prev.sessions)) {
    if (removed.has(id)) {
      touched = true
      continue
    }
    sessions[id] = meta
  }

  const populated = new Set<TabId>()
  for (const meta of Object.values(sessions)) {
    if (meta.projectId !== undefined) populated.add(meta.projectId)
  }
  // Only projects that HELD a removed session (or were named) are candidates:
  // a project that is empty for some other reason is not this call's business,
  // and sweeping it here would make an unrelated close delete a project the
  // user is mid-way through creating.
  const emptied = new Set<TabId>()
  for (const projectId of alsoIfEmpty) {
    if (!populated.has(projectId)) emptied.add(projectId)
  }
  for (const id of removed) {
    const projectId = prev.sessions[id]?.projectId
    if (projectId !== undefined && !populated.has(projectId)) emptied.add(projectId)
  }
  if (!touched && emptied.size === 0) return prev

  const tabs = emptied.size === 0 ? prev.tabs : prev.tabs.filter(tab => !emptied.has(tab.id))
  let activeTabId = prev.activeTabId
  if (emptied.has(prev.activeTabId)) {
    const index = prev.tabs.findIndex(tab => tab.id === prev.activeTabId)
    // Walk left from the removed project to the nearest survivor, then right.
    const survivor =
      [...prev.tabs.slice(0, Math.max(0, index))].reverse().find(tab => !emptied.has(tab.id)) ??
      prev.tabs.slice(index + 1).find(tab => !emptied.has(tab.id))
    activeTabId = survivor?.id ?? ''
  }

  const pinnedSessionIds = prev.pinnedSessionIds.some(id => removed.has(id))
    ? prev.pinnedSessionIds.filter(id => !removed.has(id))
    : prev.pinnedSessionIds

  // WHY the row bindings are scrubbed HERE and not only at the persistence
  // boundary (#863): `scrubGridRowMetadata` already ran in
  // `sessionOwnership.ts`, which cleans the copy written to disk — so memory
  // and disk disagreed for the rest of the session. A row left bound to a
  // project that no longer exists filters its index to nothing, and New Agent
  // from one of its empty lanes resolves the dead tab, hits `if (!tab) return
  // null` in `createDetachedDispatchAgent` and fails with NO TOAST: the
  // placement overlay stays open until the user presses Escape, because only a
  // successful spawn closes it.
  //
  // This is the one place a project leaves live state, so it is the one place
  // that has to say so.
  //
  // It runs on EVERY commit, not only when a project left: the same helper
  // also prunes `expandedParents`, and a parent that just closed must not stay
  // expanded either. Guarding it on `emptied.size` was the first version and
  // it silently kept that second prune from ever running. There is no cost to
  // pay for dropping the guard — `scrubGridRowMetadata` returns the SAME stage
  // object when it changes nothing, so a close that touches no row still does
  // not re-allocate the stage the user arranged (#681).
  const stage = clearTiledLaneSessions(prev.stage, removed)
  return {
    ...prev,
    tabs,
    activeTabId,
    sessions,
    pinnedSessionIds,
    stage: scrubGridRowMetadata(stage, new Set(tabs.map(tab => tab.id)), new Set(Object.keys(sessions))),
  }
}
