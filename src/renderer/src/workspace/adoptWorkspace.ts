import type { PersistedWorkspace } from '@renderer/workspace/persistence'
import type {
  BuriedPaneRecord,
  DetachedSessionRecord,
  SessionId,
  SessionMeta,
  Tab,
  TabId,
  WorkspaceState,
} from '@renderer/workspace/types'
import { collectLeaves } from '@renderer/workspace/tile-tree/treeOps'

// Taking over a closed window's workspace.
//
// WHY the surviving window merges rather than main: main deliberately treats a
// window's workspace payload as opaque bytes (see storage/workspaceFile.ts), and
// this merge needs to reason about tabs, tile leaves, detached records, pins,
// and drafts. Duplicating that model in main is exactly the second-opinion
// problem `sessionOwnership.ts` warns about — two implementations of "who owns
// this session" that are free to disagree.
//
// WHY the adopted tabs keep their tile trees instead of being flattened into
// Dispatch rows:
//
// The obvious reading of "the agents show up in Dispatch" is to convert every
// tile leaf into a `DetachedSessionRecord`. That does not typecheck against the
// data model: `Tab.root` is a `TileNode`, whose only terminal form is
// `{ type: 'leaf', sessionId }` — a tab with no panes cannot be represented at
// all. And it buys nothing, because `buildDispatchGroups` already lists BOTH
// grid-placed and detached sessions for a tab (`dispatchSelectors.ts`), so an
// adopted agent appears in the survivor's Dispatch either way. Keeping the tree
// preserves the arrangement the user built, at no cost to the outcome they
// asked for.
//
// WHY tabs move with their sessions rather than the sessions being re-homed
// onto an existing tab: `collectOwnedSessionIds` drops a detached record whose
// `projectTabId` names no tab, deliberately — "a missing parent means there is
// no surface from which the agent can be found or managed." Bare records would
// therefore be deleted by the survivor's very next autosave. Carrying the tab
// keeps every `projectTabId` valid by construction, with nothing rewritten.

export type WorkspaceAdoption =
  | {
      ok: true
      state: Pick<
        WorkspaceState,
        'tabs' | 'sessions' | 'detachedSessions' | 'buried' | 'pinnedSessionIds'
      >
      /** Sessions that landed in a tile tree and therefore need a runtime. */
      adoptedLeafSessionIds: SessionId[]
      /** Every session the survivor now owns, leaves and parked alike. */
      adoptedSessionIds: SessionId[]
      drafts: Record<SessionId, string>
    }
  | {
      /**
       * Refused. The caller must NOT delete the closing window's persisted
       * slice, so the workspace is restored as its own window on next launch
       * instead of being lost.
       */
      ok: false
      reason: string
    }

/**
 * Merge a closed window's persisted workspace into the surviving window's live
 * state.
 *
 * Pure: no IPC, no runtimes, no React. The caller applies the returned state
 * and then seeds runtimes for `adoptedLeafSessionIds`, whose backends are
 * already alive in `SessionManager`.
 */
export function adoptWorkspace(
  current: WorkspaceState,
  incoming: PersistedWorkspace,
): WorkspaceAdoption {
  const currentSessionIds = new Set(Object.keys(current.sessions))
  const currentTabIds = new Set(current.tabs.map(tab => tab.id))

  const incomingSessionIds = Object.keys(incoming.sessions ?? {})
  const collidingSessionIds = incomingSessionIds.filter(id => currentSessionIds.has(id))
  const collidingTabIds = (incoming.tabs ?? []).map(tab => tab.id).filter(id => currentTabIds.has(id))

  if (collidingSessionIds.length > 0 || collidingTabIds.length > 0) {
    // WHY the whole adoption is refused rather than the colliding rows dropped:
    //
    // Both id spaces are `randomUUID()`, so a collision means the file was
    // hand-edited or two windows somehow restored the same slice — a state
    // where "merge the parts that fit" is guessing. Dropping a colliding tab
    // would strand its sessions: alive in SessionManager, owned by no window,
    // invisible and unkillable from the UI. Refusing leaves the closed window's
    // slice on disk, so the next launch restores it as its own window with
    // everything intact. Nothing is lost; the user just gets a window back.
    return {
      ok: false,
      reason: `id collision (${collidingSessionIds.length} sessions, ${collidingTabIds.length} tabs)`,
    }
  }

  const sessions: Record<SessionId, SessionMeta> = {
    ...current.sessions,
    ...incoming.sessions,
  }

  const tabs: Tab[] = [
    ...current.tabs,
    ...(incoming.tabs ?? []).map(tab => ({
      id: tab.id,
      title: tab.title,
      root: tab.root,
      focusedSessionId: tab.focusedSessionId,
    })),
  ]

  const detachedSessions: Record<SessionId, DetachedSessionRecord> = {
    ...current.detachedSessions,
  }
  for (const entry of Object.values(incoming.detachedSessions ?? {})) {
    // `projectTabIndex` is a display ordinal for the Dispatch tab chip, and the
    // adopted tabs were appended after the survivor's own. Re-deriving it keeps
    // the chip letters matching the tab strip the user is now looking at.
    const projectTabIndex = tabs.findIndex(tab => tab.id === entry.projectTabId)
    detachedSessions[entry.sessionId] = {
      ...entry,
      ...(projectTabIndex === -1 ? {} : { projectTabIndex }),
    }
  }

  const buried: BuriedPaneRecord[] = [
    ...current.buried,
    ...(incoming.buried ?? []),
  ]

  // Pins append rather than interleave: `pinnedSessionIds` order IS the Pinned
  // section's render order, and the survivor's own pins are the ones the user
  // arranged most recently in the window they are still looking at.
  const pinnedSessionIds: SessionId[] = [
    ...current.pinnedSessionIds,
    ...(Array.isArray(incoming.pinnedSessionIds) ? incoming.pinnedSessionIds : [])
      .filter(id => sessions[id] !== undefined),
  ]

  const adoptedLeafSessionIds: SessionId[] = []
  for (const tab of incoming.tabs ?? []) {
    for (const sessionId of collectLeaves(tab.root)) {
      if (sessions[sessionId] === undefined) continue
      adoptedLeafSessionIds.push(sessionId)
    }
  }

  return {
    ok: true,
    state: { tabs, sessions, detachedSessions, buried, pinnedSessionIds },
    adoptedLeafSessionIds,
    adoptedSessionIds: incomingSessionIds,
    // Drafts are half-written prompts. Losing one to a window close is exactly
    // the kind of small, silent data loss autosave exists to prevent.
    drafts: incoming.drafts ?? {},
  }
}

/**
 * The tab ids an adoption introduces, for callers that need to know which tabs
 * are new (a toast naming them, say). Derived rather than returned as state so
 * the merge result stays a plain workspace slice.
 */
export function adoptedTabIds(
  current: WorkspaceState,
  incoming: PersistedWorkspace,
): TabId[] {
  const currentTabIds = new Set(current.tabs.map(tab => tab.id))
  return (incoming.tabs ?? []).map(tab => tab.id).filter(id => !currentTabIds.has(id))
}
