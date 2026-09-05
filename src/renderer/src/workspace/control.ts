import { z } from 'zod'
import { defineCapability, placementSchema, workspaceObservationSchema } from '@control-sdk'
import { useAppStore } from '@renderer/app-state/store'
import { collectLeaves } from '@renderer/workspace/tile-tree/treeOps'
import { resolveTabSessions } from '@renderer/workspace/queries'
import { buildGridRelatedAgentTabs, selectedGridRelatedSessionId } from '@renderer/workspace/gridRelatedAgents'
import { hasAppInteractionOwner } from '@renderer/lib/interaction-ownership'
import { commandTargetSessionIdForState } from '@renderer/workspace/hook/selectors/commandTargetSessionId'
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
  const { workspaceState: state, workspaceTileTabs: tileTabs, workspaceReaderMode: reader, workspaceSpotlight: spotlight } = store
  const takeover = reader ?? spotlight
  const placements = new Map<string, Placement[]>()
  const add = (id: string, placement: Placement) => placements.set(id, [...(placements.get(id) ?? []), placement])
  for (const tab of state.tabs) {
    const tabVisible = tileTabs ? tileTabs.tabIds.includes(tab.id) : !state.dispatchMode && state.activeTabId === tab.id
    for (const id of collectLeaves(tab.root)) {
      const visibleSession = selectedGridRelatedSessionId(state, tab.id, id) ?? id
      add(id, { kind: 'grid', tabId: tab.id, visible: tabVisible && visibleSession === id })
      for (const child of buildGridRelatedAgentTabs(state, tab.id, id)) {
        if (child.sessionId !== id) add(child.sessionId, { kind: 'related', tabId: tab.id, gridOwnerSessionId: id, visible: tabVisible && visibleSession === child.sessionId })
      }
    }
  }
  for (const [id, detached] of Object.entries(state.detachedSessions)) add(id, { kind: 'detached', tabId: detached.projectTabId, visible: false })
  if (state.dispatchMode?.tiled) {
    state.dispatchMode.tiled.lanes.forEach((lane, index) => {
      if (lane.selectedSessionId) add(lane.selectedSessionId, { kind: 'dispatch', lane: index, visible: !tileTabs })
    })
  } else if (state.dispatchMode?.focusedSessionId) {
    add(state.dispatchMode.focusedSessionId, { kind: 'dispatch', visible: !tileTabs })
  }
  if (takeover) {
    for (const rows of placements.values()) for (const placement of rows) placement.visible = false
    add(takeover.focusedSessionId, { kind: reader ? 'reader' : 'spotlight', tabId: takeover.tabId, visible: true })
  }
  const focusedTab = state.tabs.find(tab => tab.id === (tileTabs?.focusedTabId ?? state.activeTabId))
  const focusedSessionId = takeover?.focusedSessionId ?? (tileTabs
    ? selectedGridRelatedSessionId(state, focusedTab?.id ?? '', focusedTab?.focusedSessionId)
    : commandTargetSessionIdForState(state))
  for (const buried of state.buried) add(buried.sessionId, { kind: 'buried', tabId: buried.sourceTabId, visible: false })
  // Buried metadata can outlive its sessions entry. Preserve that real
  // identity rather than dropping it or inventing a second agent.
  const sessions = { ...Object.fromEntries(state.buried.map(record => [record.sessionId, record.sessionMeta])), ...state.sessions }
  return {
    observedAt: Date.now(), focusedSessionId, ui: { commandPickerOpen: store.commandPaletteOpen, settingsOpen: store.settingsPageOpen, inputOwnedBySurface: hasAppInteractionOwner() }, restoreStatus: getWorkspace().restoreStatus, activeTabId: state.activeTabId,
    mode: tileTabs ? 'tiled-tabs' as const : state.dispatchMode?.tiled ? 'tiled-dispatch' as const : state.dispatchMode ? 'dispatch' as const : 'grid' as const,
    tabs: state.tabs.map(tab => ({ id: tab.id, title: tab.title, focusedSessionId: tab.focusedSessionId, sessionIds: resolveTabSessions(state, tab.id) })),
    sessions: Object.entries(sessions).map(([sessionId, meta]) => ({
      sessionId, title: meta.title ?? '', cwd: meta.cwd, provider: meta.kind ?? DEFAULT_PROVIDER,
      providerRuntime: meta.providerRuntime ?? null, providerSessionId: meta.providerSessionId ?? null,
      pinned: state.pinnedSessionIds?.includes(sessionId) ?? false, placements: placements.get(sessionId) ?? [],
    })),
  }

}
