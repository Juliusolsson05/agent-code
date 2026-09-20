import { useMemo } from 'react'
import { buildVisibleDispatchRows } from '@renderer/workspace/dispatch/dispatchSelectors'
import { sessionDisplayTitle } from '@renderer/workspace/sessionDisplayTitle'
import type { SessionId, WorkspaceState } from '@renderer/workspace/types'
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
 * paneLabelForSession per row: the agent index's globally numbered rows are
 * the labels on screen, and they can differ from tab-local positions. Showing
 * a pane-local "A3" for an agent the user sees as "D7" would send them to the
 * wrong agent. Built once per workspace layout change as a map, because the
 * monitor looks up every process row on every poll.
 *
 * Unified stage (#992): the index is ALWAYS on screen now, and Tile Tabs is
 * gone, so the index rows always win. That is the same rule
 * resolveAgentPaneLabel applies. The old "only when Dispatch is on and Tiled
 * Tabs is off" gate and the tileTabs parameter went with the modes they
 * described.
 */
export function buildAgentIdentityIndex(state: WorkspaceState): Map<SessionId, AgentIdentity> {
  const index = new Map<SessionId, AgentIdentity>()
  const place = (sessionId: SessionId, label: string, tabTitle: string) => {
    const meta = state.sessions[sessionId]
    if (!meta || index.has(sessionId)) return
    index.set(sessionId, { sessionId, label, title: sessionDisplayTitle(meta), tabTitle })
  }
  {
    // CAVEAT: pinned dispatch rows carry labels like '★1', which the
    // workspace's label-to-session resolver deliberately cannot parse — pins
    // have no pane coordinate to resolve to. That is why every navigation
    // from the monitor goes by sessionId (focusAgentBySessionId), never by
    // re-resolving the displayed label. If label-based navigation is ever
    // added, pins must be special-cased there.
    for (const row of buildVisibleDispatchRows(state)) place(row.sessionId, row.label, row.tabTitle)
  }
  // A per-project "A1, A2…" pass sat here: it labelled sessions the index did
  // not list. The index lists every session of a live project now
  // (dispatchSelectors), so that pass never labelled anything, and if it ever
  // had, its project-local labels could collide with the index's. Sessions
  // outside a live project get no label below, which is the honest answer.
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
  const identities = useMemo(() => buildAgentIdentityIndex(workspace.state), [workspace.state])
  return { identities, focusAgent: workspace.focusAgentBySessionId }
}
