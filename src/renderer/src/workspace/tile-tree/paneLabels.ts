import { DEFAULT_PROVIDER } from '@shared/types/providerKind'
import type { SessionKind } from '@shared/types/providerKind'
import { buildVisibleDispatchRows } from '@renderer/workspace/dispatch/dispatchSelectors'
import type {
  SessionId,
  Tab,
  TabId,
  WorkspaceState,
} from '@renderer/workspace/types'
import { resolveTabSessions } from '@renderer/workspace/queries'
import { sessionDisplayTitle } from '@renderer/workspace/sessionDisplayTitle'
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
  kind: SessionKind
}

/** Stable identity entry point for bookmarks, automation and future UI links.
 * Membership still comes from the canonical project query; a buried record is
 * intentionally not a navigable live placement until explicitly restored. */
export function resolveAgentSessionTarget(state: WorkspaceState, sessionId: SessionId): AgentPaneLabelTarget | null {
  const owners = state.tabs.filter(tab => resolveTabSessions(state, tab.id).includes(sessionId))
  if (owners.length !== 1) return null
  const tab = owners[0]
  return buildAgentPaneLabelTarget(state, paneLabelForSession(state, tab.id, sessionId), sessionId, tab.id)
}

/**
 * Resolve the compact label the user can already see in pane/Dispatch chrome.
 *
 * WHY this belongs beside paneLabelForSession instead of in the command
 * palette: `A2` is workspace identity, not search syntax. Dispatch, grid,
 * Tiled Tabs, and any future navigation surface must all agree on one
 * ordering for every session kind, terminals included (#865). Rebuilding the
 * ordering inside the palette would inevitably drift the first time
 * detached-session ordering changes.
 */
export function resolveAgentPaneLabel(
  state: WorkspaceState,
  input: string,
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
  // (A Tile Tabs precedence check lived here until #992 deleted Tile Tabs.)
  //
  // (The index lookup was gated on "Dispatch is on" until the stage became a
  // required field. The index is always on screen now, so it always wins.)
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

/**
 * The label a session shows on screen, or null when it shows none.
 *
 * WHY this lives here and is shared (#1145): `workspace.observe` published
 * this as `displayLabel`, and Agent Management records must publish the SAME
 * string — an agent told "prompt B28" reads the label from one surface and
 * may act through the other. The rule used to be an inline closure in
 * observeWorkspace; a second copy in the Agent Management descriptor would be
 * the drift this module's header warns about.
 *
 * WHY the fallback is verified through resolveAgentPaneLabel: Dispatch row
 * labels can shadow project-local labels (see resolveAgentPaneLabel). Only a
 * fallback that the resolver maps back to this same session is advertised, so
 * for every `[A-Z]+N` label `displayLabel(X) === L` exactly when
 * `resolveAgentPaneLabel(state, L)` returns X. Agent Management's label
 * targeting and `ac_agents_search {label}` rely on that equivalence to agree.
 *
 * `rows` is the caller's `buildVisibleDispatchRows(state)`: both callers label
 * every session in one pass, and rebuilding the row stream per session would
 * make a listing quadratic in the pool size.
 */
export function sessionDisplayLabel(
  state: WorkspaceState,
  sessionId: SessionId,
  rows: readonly { sessionId: SessionId; label: string }[],
): string | null {
  const row = rows.find(candidate => candidate.sessionId === sessionId)
  if (row) return row.label
  const tabId = state.sessions[sessionId]?.projectId
  const tab = tabId === undefined ? undefined : state.tabs.find(candidate => candidate.id === tabId)
  if (!tab) return null
  const localLabel = paneLabelForSession(state, tab.id, sessionId)
  return resolveAgentPaneLabel(state, localLabel)?.sessionId === sessionId ? localLabel : null
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
  // Any session kind is navigable by label (#865). #546 scoped this to agents
  // "instead of becoming a hidden second terminal-navigation feature", but
  // Dispatch ⌘N and ⌥↑/↓ already selected terminals, so the two paths disagreed.
  return {
    label,
    sessionId,
    tabId,
    tabTitle: tab.title,
    title: sessionDisplayTitle(meta),
    cwd: meta.cwd,
    kind,
  }
}
