import { collectLeaves } from '@renderer/workspace/tile-tree/treeOps'
import type { SessionId, SessionKind, TabId, WorkspaceState } from '@renderer/workspace/types'

export type GridRelatedAgentRelation = 'parent' | 'linked' | 'orchestration'

export type GridRelatedAgentTab = {
  sessionId: SessionId
  relation: GridRelatedAgentRelation
  label: string
  title: string
  kind: SessionKind | undefined
  placement: 'grid' | 'detached'
}

export function buildGridRelatedAgentTabs(
  state: WorkspaceState,
  tabId: TabId,
  ownerSessionId: SessionId,
): GridRelatedAgentTab[] {
  const ownerMeta = state.sessions[ownerSessionId]
  if (!ownerMeta || ownerMeta.kind === 'terminal') return []

  const candidateIds = sessionIdsOwnedByTab(state, tabId)
  const tabs: GridRelatedAgentTab[] = [{
    sessionId: ownerSessionId,
    relation: 'parent',
    label: 'parent',
    title: titleForSession(ownerMeta),
    kind: ownerMeta.kind,
    placement: state.detachedSessions[ownerSessionId] ? 'detached' : 'grid',
  }]

  for (const sessionId of candidateIds) {
    if (sessionId === ownerSessionId) continue
    const meta = state.sessions[sessionId]
    if (!meta || meta.kind === 'terminal') continue

    // WHY direct linked parent and orchestration root both count here:
    // linked agents flatten to one parent by construction, while orchestration
    // can spawn a root run with several workers. In grid mode the user's
    // question is "what work belongs to this visible parent pane?", so the
    // root should expose the whole run and an intermediate orchestrator should
    // still expose its direct children.
    const isLinked = meta.linkedParentId === ownerSessionId
    const isOrchestration =
      meta.orchestrationParentId === ownerSessionId ||
      meta.orchestrationRootId === ownerSessionId
    if (!isLinked && !isOrchestration) continue

    const relation: GridRelatedAgentRelation = isLinked ? 'linked' : 'orchestration'
    tabs.push({
      sessionId,
      relation,
      label: relation === 'linked'
        ? 'link'
        : (meta.orchestrationRole?.trim() || meta.title?.trim() || 'orch'),
      title: titleForSession(meta),
      kind: meta.kind,
      placement: state.detachedSessions[sessionId] ? 'detached' : 'grid',
    })
  }

  return tabs.length > 1 ? tabs : []
}

export function selectedGridRelatedSessionId(
  state: WorkspaceState,
  tabId: TabId,
  ownerSessionId: SessionId | null | undefined,
): SessionId | null {
  if (!ownerSessionId) return null
  const selected = state.gridRelatedSelections?.[ownerSessionId]
  if (!selected || selected === ownerSessionId) return ownerSessionId
  const tabs = buildGridRelatedAgentTabs(state, tabId, ownerSessionId)
  return tabs.some(tab => tab.sessionId === selected) ? selected : ownerSessionId
}

function sessionIdsOwnedByTab(state: WorkspaceState, tabId: TabId): SessionId[] {
  const tab = state.tabs.find(item => item.id === tabId)
  const gridSessionIds = new Set(tab ? collectLeaves(tab.root) : [])
  const detachedSessionIds = Object.values(state.detachedSessions)
    .filter(entry => (
      entry.surface === 'dispatch' &&
      entry.projectTabId === tabId &&
      state.sessions[entry.sessionId] !== undefined
    ))
    .sort((a, b) => a.detachedAt - b.detachedAt)
    .map(entry => entry.sessionId)

  // WHY attached/grid children are deliberately excluded:
  // selecting a related tab renders that session inside the parent's physical
  // pane. If the child already has its own grid leaf, exposing it here would
  // mount the same session twice, duplicating `data-pane-id`, composer state,
  // and debug targets. The mini tabs are for detached children that otherwise
  // have no grid-facing surface.
  return detachedSessionIds.filter(sessionId => !gridSessionIds.has(sessionId))
}

function titleForSession(meta: WorkspaceState['sessions'][SessionId] | undefined): string {
  if (meta?.title?.trim()) return meta.title.trim()
  const cwd = meta?.cwd ?? 'agent'
  const parts = cwd.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? cwd
}
