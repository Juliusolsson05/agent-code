import type {
  SessionId,
  TabId,
  WorkspaceState,
} from '@renderer/workspace/types'
import { clearTiledLaneSessions } from '@renderer/workspace/dispatch/tiledDispatchSelectors'
import type {
  WorkspaceSetReaderMode,
  WorkspaceSetSpotlight,
} from '@renderer/workspace/hook/context'

// -----------------------------------------------------------------------------
// The ONE tab-removal tail (#153 acceptance: "root-pane close and tab close have
// consistent, documented semantics").
//
// WHY this exists: a project tab disappears in exactly one place — when a close
// operation commits the removal of the tab's last grid leaf and no Dispatch row
// is left to promote (`closeApprovedTarget` in pane.ts). Both "Close Tab" entry
// points reach that commit through the SAME executor since #886 review round 2:
// the Close Tab command (⌘⇧W, the tab bar ×) and the root dialog's "Close Tab"
// button. Before that the command had a hand-written copy, and its removal
// tail had drifted from the pane path's:
//
//   - next active tab: the command activated `tabs[0]`, the pane path the
//     previous neighbour;
//   - takeovers: the command cleared Tiled Tabs / Spotlight / Reader for the
//     removed tab, the pane path left them for the invalidation effects to heal
//     on a later render.
//
// Round 1 converged only this tail, which was not enough: the command still
// killed a narrower set than its own dialog listed, pushed undo before killing
// and killed concurrently. Now the whole operation is shared, and this module is
// the shape of its one tab-removing commit, so the two buttons named "Close
// Tab" cannot diverge again.
//
// WHY the previous neighbour wins over `tabs[0]`: every other removal in this
// codebase keeps the cursor near where it was (bury's emptied tab, Dispatch's
// row successor in pane.ts, native tab bars). Jumping to the first tab after
// closing the ninth is the surprising choice, and the command was the only
// place doing it.
// -----------------------------------------------------------------------------

// `dispatchModeAfterSessionRemovals` lived here until #992. It cleared lanes
// and THEN cleared a classic-Dispatch focus that pointed at a removed session.
// With the classic focus gone the whole job is `clearTiledLaneSessions`, so
// the wrapper was deleted rather than kept as a one-line alias — a second name
// for the same operation is how the two close paths drifted apart before.

/**
 * Remove `tabId` and the given sessions from workspace state.
 *
 * The caller decides WHICH sessions die (the command kills the whole tab; a
 * session close removes only its own target because every other member of the
 * operation already removed itself). This helper only owns the shape of the
 * removal, so the two callers cannot disagree about focus or Dispatch cleanup.
 *
 * Only retargets `activeTabId` when the removed tab was active: a close issued
 * from a background surface (Agent Activity, Close Old Agents, automation) must
 * not yank the user out of the tab they are looking at.
 */
export function workspaceWithoutTab(
  prev: WorkspaceState,
  tabId: TabId,
  removedSessionIds: Iterable<SessionId>,
): WorkspaceState {
  const tabIdx = prev.tabs.findIndex(tab => tab.id === tabId)
  // A tab already gone (a concurrent close won the race) still has its killed
  // sessions' metadata removed: those backends are dead either way, and leaving
  // their SessionMeta behind would describe agents nothing can show or close.
  const tabs = tabIdx < 0 ? prev.tabs : prev.tabs.filter((_, index) => index !== tabIdx)
  const removed = new Set(removedSessionIds)
  const sessions = { ...prev.sessions }
  const detachedSessions = { ...prev.detachedSessions }
  for (const id of removed) {
    delete sessions[id]
    delete detachedSessions[id]
  }
  return {
    ...prev,
    tabs,
    activeTabId: prev.activeTabId === tabId
      ? (tabs[Math.max(0, tabIdx - 1)]?.id ?? '')
      : prev.activeTabId,
    sessions,
    detachedSessions,
    // A lane that showed a removed session goes EMPTY; it is never refilled
    // with a neighbour (U2, #681) and never removed — the user shaped the
    // stage, and closing agents must not reshape it.
    stage: clearTiledLaneSessions(prev.stage, removed),
  }
}

/** Drop view takeovers that framed the removed tab. Called after the state
 *  commit so a refused removal never clears a takeover the user still has. */
export function clearRemovedTabTakeovers(
  setters: {
    setSpotlight: WorkspaceSetSpotlight
    setReaderMode: WorkspaceSetReaderMode
  },
  tabId: TabId,
): void {
  setters.setSpotlight(prev => (prev?.tabId === tabId ? null : prev))
  setters.setReaderMode(prev => (prev?.tabId === tabId ? null : prev))
}
