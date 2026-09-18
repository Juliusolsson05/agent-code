import { useMemo } from 'react'
import { buildVisibleDispatchRows } from '@renderer/workspace/dispatch/dispatchSelectors'
import { resolveTabSessions } from '@renderer/workspace/queries'
import { sessionDisplayTitle } from '@renderer/workspace/sessionDisplayTitle'
import { tabIndexLabel } from '@renderer/workspace/tile-tree/paneLabelFormat'
import type { SessionId, TileTabsState, WorkspaceState } from '@renderer/workspace/types'
import { useWorkspaceLayoutContext } from '@renderer/workspace/WorkspaceContext'

export type AgentIdentity = {
  sessionId: SessionId
  /** The coordinate the user sees beside the agent (A15, D3), or null for a
   * session this window does not place anywhere (another window, buried). */
  label: string | null
  title: string
  tabTitle: string | null
}

/**
 * sessionId → the name and label a person recognizes.
 *
 * WHY this mirrors resolveAgentPaneLabel's precedence instead of calling
 * paneLabelForSession per row: when Dispatch is the visible surface (and Tiled
 * Tabs is not), its globally numbered rows are the labels on screen, and they
 * differ from tab-local pane positions. Showing a pane-local "A3" for an agent
 * the user sees as "D7" would send them to the wrong agent. Built once per
 * workspace layout change as a map, because the monitor looks up every process
 * row on every poll.
 */
export function buildAgentIdentityIndex(state: WorkspaceState, tileTabs: TileTabsState | null): Map<SessionId, AgentIdentity> {
  const index = new Map<SessionId, AgentIdentity>()
  const place = (sessionId: SessionId, label: string, tabTitle: string) => {
    const meta = state.sessions[sessionId]
    if (!meta || index.has(sessionId)) return
    index.set(sessionId, { sessionId, label, title: sessionDisplayTitle(meta), tabTitle })
  }
  if (state.dispatchMode && !tileTabs) {
    // CAVEAT: pinned dispatch rows carry labels like '★1', which the
    // workspace's label-to-session resolver deliberately cannot parse — pins
    // have no pane coordinate to resolve to. That is why every navigation
    // from the monitor goes by sessionId (focusAgentBySessionId), never by
    // re-resolving the displayed label. If label-based navigation is ever
    // added, pins must be special-cased there.
    for (const row of buildVisibleDispatchRows(state)) place(row.sessionId, row.label, row.tabTitle)
  }
  state.tabs.forEach((tab, tabIndex) => {
    resolveTabSessions(state, tab.id).forEach((sessionId, paneIndex) => place(sessionId, `${tabIndexLabel(tabIndex)}${paneIndex + 1}`, tab.title))
  })
  for (const [sessionId, meta] of Object.entries(state.sessions)) {
    if (!index.has(sessionId)) index.set(sessionId, { sessionId, label: null, title: sessionDisplayTitle(meta), tabTitle: null })
  }
  return index
}

/** Identities plus the one navigation path every agent-label surface shares
 * (wake a detached agent, then focus it), so the monitor never re-implements
 * placement rules. Layout context only: runtime traffic must not re-render a
 * table that polls on its own schedule. */
export function useAgentIdentities() {
  const workspace = useWorkspaceLayoutContext()
  const identities = useMemo(() => buildAgentIdentityIndex(workspace.state, workspace.tileTabs), [workspace.state, workspace.tileTabs])
  return { identities, focusAgent: workspace.focusAgentBySessionId }
}
