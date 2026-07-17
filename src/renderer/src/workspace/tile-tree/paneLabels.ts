import { DEFAULT_PROVIDER, isAgentProviderKind } from '@shared/types/providerKind'
import type { AgentProviderKind } from '@shared/types/providerKind'
import { buildVisibleDispatchRows } from '@renderer/workspace/dispatch/dispatchSelectors'
import type {
  SessionId,
  Tab,
  TabId,
  TileTabsState,
  WorkspaceState,
} from '@renderer/workspace/types'
import { resolveTabSessions } from '@renderer/workspace/queries'
import { tabIndexLabel } from '@renderer/workspace/tile-tree/paneLabelFormat'

export { tabIndexLabel } from '@renderer/workspace/tile-tree/paneLabelFormat'

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
  tileTabs: TileTabsState | null = null,
): AgentPaneLabelTarget | null {
  const requestedLabel = input.trim().toUpperCase()
  if (!/^[A-Z]+[1-9]\d*$/.test(requestedLabel)) return null

  // WHY Dispatch labels must win before the pane-local fallback: Dispatch has
  // always numbered the FINAL visible row stream, after pins are removed,
  // linked children are nested, and (in global scope) earlier projects consume
  // numbers. Those coordinates intentionally differ from resolveTabSessions.
  // Matching the visible row first means typing the label beside an agent can
  // never focus a different pane-local session. The fallback remains valuable
  // for an agent in a project outside project-scoped Dispatch: its grid label is
  // still a valid workspace coordinate even though that project is not in the
  // current Dispatch index.
  //
  // TileTabs wins MainSurface's render precedence over stale Dispatch state.
  // Persisted workspaces can contain both because the two slices rehydrate
  // independently, so hidden Dispatch rows must not redefine coordinates while
  // the user is visibly looking at Tiled Tabs.
  if (state.dispatchMode && !tileTabs) {
    const dispatchRow = buildVisibleDispatchRows(state).find(
      row => row.label === requestedLabel,
    )
    if (dispatchRow) {
      return buildAgentPaneLabelTarget(
        state,
        requestedLabel,
        dispatchRow.sessionId,
        dispatchRow.tabId,
      )
    }
  }

  for (let tabIndex = 0; tabIndex < state.tabs.length; tabIndex++) {
    const tab = state.tabs[tabIndex]
    const sessionIds = resolveTabSessions(state, tab.id)
    for (let paneIndex = 0; paneIndex < sessionIds.length; paneIndex++) {
      const label = `${tabIndexLabel(tabIndex)}${paneIndex + 1}`
      if (label !== requestedLabel) continue

      return buildAgentPaneLabelTarget(
        state,
        label,
        sessionIds[paneIndex],
        tab.id,
      )
    }
  }

  return null
}

function buildAgentPaneLabelTarget(
  state: WorkspaceState,
  label: string,
  sessionId: SessionId,
  tabId: TabId,
): AgentPaneLabelTarget | null {
  const tab = state.tabs.find(candidate => candidate.id === tabId)
  const meta = state.sessions[sessionId]
  if (!tab || !meta) return null
  const kind = meta.kind ?? DEFAULT_PROVIDER
  // Terminals deliberately keep their visible coordinate (so an A2 agent does
  // not become A1 merely because A1 is a terminal), but issue #546 is an
  // agent-navigation affordance. A Dispatch row match must also stop here
  // rather than fall through to a different pane-local agent with the same
  // coordinate: the user pointed at the visible terminal, not that agent.
  if (!isAgentProviderKind(kind)) return null

  const cwdParts = meta.cwd.split('/').filter(Boolean)
  return {
    label,
    sessionId,
    tabId,
    tabTitle: tab.title,
    title: meta.title?.trim() || cwdParts[cwdParts.length - 1] || meta.cwd,
    cwd: meta.cwd,
    kind,
  }
}
