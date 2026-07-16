import { DEFAULT_PROVIDER, isAgentProviderKind } from '@shared/types/providerKind'
import type { AgentProviderKind } from '@shared/types/providerKind'
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

export type AgentPaneLabelTarget = {
  label: string
  sessionId: SessionId
  tabId: TabId
  tabTitle: string
  title: string
  cwd: string
  kind: AgentProviderKind
}

/**
 * Resolve the compact label the user can already see in pane/Dispatch chrome.
 *
 * WHY this belongs beside paneLabelForSession instead of in the command
 * palette: `A2` is workspace identity, not search syntax. Dispatch, grid,
 * Tiled Tabs, and any future navigation surface must all agree that terminals
 * still occupy an index position while only provider agents are navigable for
 * issue #546. Rebuilding the ordering inside the palette would inevitably
 * drift the first time detached-session ordering changes.
 */
export function resolveAgentPaneLabel(
  state: WorkspaceState,
  input: string,
): AgentPaneLabelTarget | null {
  const requestedLabel = input.trim().toUpperCase()
  if (!/^[A-Z]+[1-9]\d*$/.test(requestedLabel)) return null

  for (let tabIndex = 0; tabIndex < state.tabs.length; tabIndex++) {
    const tab = state.tabs[tabIndex]
    const sessionIds = resolveTabSessions(state, tab.id)
    for (let paneIndex = 0; paneIndex < sessionIds.length; paneIndex++) {
      const label = `${tabIndexLabel(tabIndex)}${paneIndex + 1}`
      if (label !== requestedLabel) continue

      const sessionId = sessionIds[paneIndex]
      const meta = state.sessions[sessionId]
      if (!meta) return null
      const kind = meta.kind ?? DEFAULT_PROVIDER
      // Terminals deliberately keep their visible coordinate (so an A2 agent
      // does not become A1 merely because A1 is a terminal), but issue #546 is
      // an agent-navigation affordance. An exact terminal label therefore
      // falls through to ordinary command search instead of becoming a hidden
      // second terminal-navigation feature.
      if (!isAgentProviderKind(kind)) return null

      const cwdParts = meta.cwd.split('/').filter(Boolean)
      return {
        label,
        sessionId,
        tabId: tab.id,
        tabTitle: tab.title,
        title: meta.title?.trim() || cwdParts[cwdParts.length - 1] || meta.cwd,
        cwd: meta.cwd,
        kind,
      }
    }
  }

  return null
}
