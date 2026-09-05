import { z } from 'zod'
import { defineCapability } from '@control-sdk'
import { useAppStore } from '@renderer/app-state/store'
import { collectLeaves } from '@renderer/workspace/tile-tree/treeOps'
import { resolveTabSessions } from '@renderer/workspace/queries'
import { selectedGridRelatedSessionId } from '@renderer/workspace/gridRelatedAgents'
import { DEFAULT_PROVIDER } from '@shared/types/providerKind'
import type { Workspace } from '@renderer/workspace/hook'

const placementSchema = z.object({
  kind: z.enum(['grid', 'related', 'dispatch', 'detached', 'buried']),
  tabId: z.string().optional(), lane: z.number().optional(),
  gridOwnerSessionId: z.string().optional(), visible: z.boolean(),
})
type Placement = z.infer<typeof placementSchema>

export function workspaceControlCapabilities(getWorkspace: () => Pick<Workspace, 'restoreStatus'>) {
  return [defineCapability({
    id: 'workspace.observe', title: 'Observe workspace',
    description: 'Read current project, session and placement identities without waking agents. Includes hidden, detached and buried sessions; multiple placements refer to one session.',
    execution: 'window', effect: 'read', input: z.object({}).strict(),
    output: z.object({
      observedAt: z.number(), restoreStatus: z.string(), activeTabId: z.string(),
      mode: z.enum(['grid', 'tiled-tabs', 'dispatch', 'tiled-dispatch']),
      tabs: z.array(z.object({ id: z.string(), title: z.string(), focusedSessionId: z.string(), sessionIds: z.array(z.string()) })),
      sessions: z.array(z.object({
        sessionId: z.string(), title: z.string(), cwd: z.string(), provider: z.string(),
        providerRuntime: z.string().nullable(), providerSessionId: z.string().nullable(),
        pinned: z.boolean(), placements: z.array(placementSchema),
      })),
    }),
    handler: () => {
      // Read on demand, not through a React subscription or persisted JSON.
      // Closed-panel cost stays independent of token streaming; the workspace
      // file's debounce window never masquerades as current UI state.
      const { workspaceState: state, workspaceTileTabs: tileTabs } = useAppStore.getState()
      const placements = new Map<string, Placement[]>()
      const add = (id: string, placement: Placement) => placements.set(id, [...(placements.get(id) ?? []), placement])
      for (const tab of state.tabs) {
        const tabVisible = tileTabs ? tileTabs.tabIds.includes(tab.id) : !state.dispatchMode && state.activeTabId === tab.id
        for (const id of collectLeaves(tab.root)) {
          const visibleSession = selectedGridRelatedSessionId(state, tab.id, id) ?? id
          add(id, { kind: 'grid', tabId: tab.id, visible: tabVisible && visibleSession === id })
          if (visibleSession !== id) add(visibleSession, { kind: 'related', tabId: tab.id, gridOwnerSessionId: id, visible: tabVisible })
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
      for (const buried of state.buried) add(buried.sessionId, { kind: 'buried', tabId: buried.sourceTabId, visible: false })
      // Buried metadata can outlive its sessions entry. Preserve that real
      // identity rather than dropping it or inventing a second agent.
      const sessions = { ...Object.fromEntries(state.buried.map(record => [record.sessionId, record.sessionMeta])), ...state.sessions }
      return {
        observedAt: Date.now(), restoreStatus: getWorkspace().restoreStatus, activeTabId: state.activeTabId,
        mode: tileTabs ? 'tiled-tabs' as const : state.dispatchMode?.tiled ? 'tiled-dispatch' as const : state.dispatchMode ? 'dispatch' as const : 'grid' as const,
        tabs: state.tabs.map(tab => ({ id: tab.id, title: tab.title, focusedSessionId: tab.focusedSessionId, sessionIds: resolveTabSessions(state, tab.id) })),
        sessions: Object.entries(sessions).map(([sessionId, meta]) => ({
          sessionId, title: meta.title ?? '', cwd: meta.cwd, provider: meta.kind ?? DEFAULT_PROVIDER,
          providerRuntime: meta.providerRuntime ?? null, providerSessionId: meta.providerSessionId ?? null,
          pinned: state.pinnedSessionIds?.includes(sessionId) ?? false, placements: placements.get(sessionId) ?? [],
        })),
      }
    },
  })]
}
