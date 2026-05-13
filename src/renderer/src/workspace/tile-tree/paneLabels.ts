import type { SessionId, Tab, TabId, WorkspaceState } from '@renderer/workspace/types'
import { resolveTabSessions } from '@renderer/workspace/queries'

export function tabIndexLabel(index: number): string {
  if (index < 0) return '?'
  let n = index
  let label = ''
  do {
    label = String.fromCharCode(65 + (n % 26)) + label
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return label
}

// Stable label for a session inside a tab. Format: `<TabLetter><Index>`,
// e.g. "A1", "B3". The index is 1-based and stable across grid +
// detached sessions in the tab — resolveTabSessions yields grid leaves
// first (tile-tree order), then detached agents (oldest-detached
// first). For a grid-leaf session this matches the historical
// `collectLeaves(tab.root)` indexing exactly, so existing callers
// (TileTree, DispatchLayout) keep producing the same strings; detached
// sessions surfaced by the Performance Panel after the grid-vs-dispatch
// migration now get a meaningful label instead of "?".
//
// The `state` parameter exists because resolveTabSessions needs the
// full WorkspaceState (it composes grid leaves with
// state.detachedSessions). Pass `workspace.state` at the call site.
export function paneLabelForSession(
  state: WorkspaceState,
  tabId: TabId,
  sessionId: SessionId,
): string {
  const tabs: Tab[] = state.tabs
  const tabIndex = tabs.findIndex(tab => tab.id === tabId)
  if (tabIndex < 0) return '?'
  const paneIndex = resolveTabSessions(state, tabId).indexOf(sessionId)
  return `${tabIndexLabel(tabIndex)}${paneIndex >= 0 ? paneIndex + 1 : '?'}`
}
