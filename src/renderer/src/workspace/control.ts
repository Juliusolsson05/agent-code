import { z } from 'zod'
import { defineCapability, placementSchema, workspaceObservationSchema } from '@control-sdk'
import { useAppStore } from '@renderer/app-state/store'
import { collectLeaves } from '@renderer/workspace/tile-tree/treeOps'
import { resolveTabSessions } from '@renderer/workspace/queries'
import { buildGridRelatedAgentTabs } from '@renderer/workspace/gridRelatedAgents'
import { hasAppInteractionOwner } from '@renderer/lib/interaction-ownership'
import { commandTargetSessionIdForState } from '@renderer/workspace/hook/selectors/commandTargetSessionId'
import { buildVisibleDispatchRows } from '@renderer/workspace/dispatch/dispatchSelectors'
import { dispatchRowTitle } from '@renderer/workspace/dispatch/rowTitle'
import { sessionDisplayTitle } from '@renderer/workspace/sessionDisplayTitle'
import { paneLabelForSession, resolveAgentPaneLabel } from '@renderer/workspace/tile-tree/paneLabels'
import { resolveAgentName } from '@renderer/workspace/agentNames/selectors'
import { DEFAULT_PROVIDER } from '@shared/types/providerKind'
import type { Workspace } from '@renderer/workspace/hook'

type Placement = z.infer<typeof placementSchema>
export { workspaceObservationSchema } from '@control-sdk'

export function workspaceControlCapabilities(getWorkspace: () => Pick<Workspace, 'restoreStatus'>) {
  return [defineCapability({
    id: 'workspace.observe', title: 'Observe workspace',
    description: 'Read current project, session and placement identities without waking agents. Includes hidden, detached and buried sessions; multiple placements refer to one session.',
    execution: 'window', effect: 'read', input: z.object({}).strict(),
    output: workspaceObservationSchema,
    handler: () => observeWorkspace(getWorkspace),
  })]
}

export function observeWorkspace(getWorkspace: () => Pick<Workspace, 'restoreStatus'>) {
  // Read on demand, not through a React subscription or persisted JSON.
  // Closed-panel cost stays independent of token streaming; the workspace
  // file's debounce window never masquerades as current UI state.
  const store = useAppStore.getState()
  const { workspaceState: state, workspaceReaderMode: reader, workspaceSpotlight: spotlight } = store
  const takeover = reader ?? spotlight
  const placements = new Map<string, Placement[]>()
  const add = (id: string, placement: Placement) => placements.set(id, [...(placements.get(id) ?? []), placement])
  for (const tab of state.tabs) {
    // A tree leaf is never on screen: nothing renders the tile tree since the
    // stage became the only layout (#992). The 'grid' and 'related' placements
    // are still REPORTED — the tree is still the v2 owner of these sessions
    // until stage 3b-ii deletes it, and a caller asking "where does this
    // session live" deserves the true answer — but only a lane is `visible`.
    // (They used to be visible when Dispatch was off and the tab was active.)
    for (const id of collectLeaves(tab.root)) {
      add(id, { kind: 'grid', tabId: tab.id, visible: false })
      for (const child of buildGridRelatedAgentTabs(state, tab.id, id)) {
        if (child.sessionId !== id) add(child.sessionId, { kind: 'related', tabId: tab.id, gridOwnerSessionId: id, visible: false })
      }
    }
  }
  for (const [id, detached] of Object.entries(state.detachedSessions)) add(id, { kind: 'detached', tabId: detached.projectTabId, visible: false })
  state.stage.lanes.forEach((lane, index) => {
    if (lane.selectedSessionId) add(lane.selectedSessionId, { kind: 'dispatch', lane: index, visible: true })
  })
  if (takeover) {
    for (const rows of placements.values()) for (const placement of rows) placement.visible = false
    add(takeover.focusedSessionId, { kind: reader ? 'reader' : 'spotlight', tabId: takeover.tabId, visible: true })
  }
  const focusedSessionId = takeover?.focusedSessionId ?? commandTargetSessionIdForState(state)
  for (const buried of state.buried) add(buried.sessionId, { kind: 'buried', tabId: buried.sourceTabId, visible: false })
  // Buried metadata can outlive its sessions entry. Preserve that real
  // identity rather than dropping it or inventing a second agent.
  const sessions = { ...Object.fromEntries(state.buried.map(record => [record.sessionId, record.sessionMeta])), ...state.sessions }
  const dispatchRows = buildVisibleDispatchRows(state)
  const identity = (sessionId: string, meta: (typeof sessions)[string]) => {
    const row = dispatchRows.find(row => row.sessionId === sessionId)
    const tab = state.tabs.find(tab => resolveTabSessions(state, tab.id).includes(sessionId))
    const localLabel = tab ? paneLabelForSession(state, tab.id, sessionId) : null
    // Dispatch labels can shadow project-local labels. Only advertise a
    // fallback that the app's label resolver maps back to this same session.
    const displayLabel = row?.label ?? (localLabel && resolveAgentPaneLabel(state, localLabel)?.sessionId === sessionId ? localLabel : null)
    const runtime = store.workspaceRuntimes[sessionId]
    const displayedTitle = row
      ? dispatchRowTitle(row, runtime?.entries, runtime?.terminalForeground?.cwd)
      : sessionDisplayTitle(meta, runtime?.terminalForeground?.cwd)
    const agentName = resolveAgentName({
      // Read from the SAME store snapshot the rest of this observation uses.
      // Re-reading getState() here could interleave with a reconciliation and
      // report a name for a session whose metadata this call has not seen.
      enabled: store.settings.agentNamesEnabled,
      meta,
      names: store.workspaceAgentNames,
    })
    return { displayLabel, displayedTitle, agentName }
  }
  return {
    observedAt: Date.now(), focusedSessionId, ui: { commandPickerOpen: store.commandPaletteOpen, settingsOpen: store.settingsPageOpen, inputOwnedBySurface: hasAppInteractionOwner() }, restoreStatus: getWorkspace().restoreStatus, activeTabId: state.activeTabId,
    // There is one layout (#992), so this is a constant. It is still reported,
    // under the name the lane grid has always had on this surface, because
    // `mode` is a required field of a published observation schema and agents
    // branch on it ("am I looking at lanes?"). The honest rename — and the
    // removal of the 'grid' and 'dispatch' enum members nothing can produce —
    // belongs to the SDK schema change in stage 7, not to a renderer commit.
    mode: 'tiled-dispatch' as const,
    tabs: state.tabs.map(tab => ({ id: tab.id, title: tab.title, focusedSessionId: tab.focusedSessionId, sessionIds: resolveTabSessions(state, tab.id) })),
    sessions: Object.entries(sessions).map(([sessionId, meta]) => ({
      sessionId, ...identity(sessionId, meta), title: meta.title ?? '', cwd: meta.cwd, provider: meta.kind ?? DEFAULT_PROVIDER,
      providerRuntime: meta.providerRuntime ?? null, providerSessionId: meta.providerSessionId ?? null,
      pinned: state.pinnedSessionIds?.includes(sessionId) ?? false, placements: placements.get(sessionId) ?? [],
    })),
  }

}
