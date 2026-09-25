import { z } from 'zod'
import { defineCapability, placementSchema, workspaceObservationSchema } from '@control-sdk'
import { useAppStore } from '@renderer/app-state/store'
import { resolveTabSessions } from '@renderer/workspace/queries'
import { hasAppInteractionOwner } from '@renderer/lib/interaction-ownership'
import { commandTargetSessionIdForState } from '@renderer/workspace/hook/selectors/commandTargetSessionId'
import { buildVisibleDispatchRows } from '@renderer/workspace/dispatch/dispatchSelectors'
import { dispatchRowTitle } from '@renderer/workspace/dispatch/rowTitle'
import { sessionDisplayTitle } from '@renderer/workspace/sessionDisplayTitle'
import { sessionDisplayLabel } from '@renderer/workspace/tile-tree/paneLabels'
import { resolveAgentName } from '@renderer/workspace/agentNames/selectors'
import { DEFAULT_PROVIDER } from '@shared/types/providerKind'
import type { Workspace } from '@renderer/workspace/hook'

type Placement = z.infer<typeof placementSchema>
export { workspaceObservationSchema } from '@control-sdk'

export function workspaceControlCapabilities(getWorkspace: () => Pick<Workspace, 'restoreStatus'>) {
  return [defineCapability({
    id: 'workspace.observe', title: 'Observe workspace',
    description: 'Read current project, session and placement identities without waking agents. Includes every parked session, whether or not a lane shows it; multiple placements refer to one session.',
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
  // Ownership: one placement per session — the project it is filed under. It
  // is never `visible` by itself; being in the pool puts nothing on screen.
  //
  // Until #992 there were four ownership placements, one per v2 owner
  // structure: 'grid' (a tile leaf), 'related' (a child shown inside its
  // parent's tile), 'detached' (a Dispatch row) and 'buried' (a hidden pane,
  // whose metadata could outlive its `sessions` row). All four meant "this
  // session belongs to that project", which is what 'project' now says.
  for (const [id, meta] of Object.entries(state.sessions)) {
    if (meta.projectId !== undefined) add(id, { kind: 'project', tabId: meta.projectId, visible: false })
  }
  state.stage.lanes.forEach((lane, index) => {
    if (lane.selectedSessionId) add(lane.selectedSessionId, { kind: 'dispatch', lane: index, visible: true })
  })
  if (takeover) {
    for (const rows of placements.values()) for (const placement of rows) placement.visible = false
    add(takeover.focusedSessionId, { kind: reader ? 'reader' : 'spotlight', tabId: takeover.tabId, visible: true })
  }
  const focusedSessionId = takeover?.focusedSessionId ?? commandTargetSessionIdForState(state)
  const sessions = state.sessions
  const dispatchRows = buildVisibleDispatchRows(state)
  const identity = (sessionId: string, meta: (typeof sessions)[string]) => {
    const row = dispatchRows.find(row => row.sessionId === sessionId)
    // Shared with Agent Management (#1145) so both surfaces publish the one
    // string the user reads on screen; see sessionDisplayLabel's WHY.
    const displayLabel = sessionDisplayLabel(state, sessionId, dispatchRows)
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
    tabs: state.tabs.map(tab => ({ id: tab.id, title: tab.title, sessionIds: resolveTabSessions(state, tab.id) })),
    sessions: Object.entries(sessions).map(([sessionId, meta]) => ({
      sessionId, ...identity(sessionId, meta), title: meta.title ?? '', cwd: meta.cwd, provider: meta.kind ?? DEFAULT_PROVIDER,
      providerRuntime: meta.providerRuntime ?? null, providerSessionId: meta.providerSessionId ?? null,
      pinned: state.pinnedSessionIds?.includes(sessionId) ?? false, placements: placements.get(sessionId) ?? [],
    })),
  }

}
