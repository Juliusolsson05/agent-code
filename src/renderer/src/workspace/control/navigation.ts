import { z } from 'zod'
import { ControlError, defineCapability, paginate } from '@control-sdk'
import { useAppStore } from '@renderer/app-state/store'
import { hasAppInteractionOwner } from '@renderer/lib/interaction-ownership'
import { collectLeaves } from '@renderer/workspace/tile-tree/treeOps'
import { resolveTabSessions } from '@renderer/workspace/queries'
import type { Workspace } from '@renderer/workspace/hook'

const session = z.object({ sessionId: z.string().min(1) }).strict()
export function navigationControlCapabilities(getWorkspace: () => Workspace) {
  const ready = () => {
    if (getWorkspace().restoreStatus === 'pending' || hasAppInteractionOwner()) throw new ControlError('unavailable', 'Wait for restoration or finish the input-owning surface')
  }
  const placement = (sessionId: string) => {
    const state = useAppStore.getState().workspaceState
    if (!state.sessions[sessionId]) throw new ControlError('unavailable', 'Session no longer exists')
    const tabs = state.tabs.filter(tab => resolveTabSessions(state, tab.id).includes(sessionId))
    const buried = state.buried.some(row => row.sessionId === sessionId)
    const grid = tabs.find(tab => collectLeaves(tab.root).includes(sessionId))
    const affectedSessionIds = grid && collectLeaves(grid.root).length === 1 ? resolveTabSessions(state, grid.id) : [sessionId]
    // Last-pane bury also archives detached project children. Expose that
    // actual domain cascade before the caller chooses to commit it.
    const evidence = { tabs, detached: state.detachedSessions, buried: state.buried, affectedSessionIds }
    return { sessionId, gridTabId: grid?.id ?? null, buried, detached: Boolean(state.detachedSessions[sessionId]),
      affectedSessionIds, revision: paginate([evidence], { limit: 1 }, `placement:${sessionId}`).revision }
  }
  return [
    defineCapability({ id: 'placement.inspect', title: 'Inspect detach and bury consequences', execution: 'window', effect: 'read', target: { kind: 'session', field: 'sessionId' },
      description: 'Inspect exact grid/detached/buried placement and the sessions affected by burying a last grid pane. Returns the revision required for detach or bury. Does not wake or focus anything.',
      input: session, output: z.object({ sessionId: z.string(), gridTabId: z.string().nullable(), buried: z.boolean(), detached: z.boolean(), affectedSessionIds: z.array(z.string()), revision: z.string() }), handler: input => placement(input.sessionId),
    }),
    defineCapability({ id: 'placement.detach', title: 'Move a grid agent to Dispatch', execution: 'window', effect: 'mutation', target: { kind: 'session', field: 'sessionId' },
      description: 'Detach an exact grid pane through the ordinary placement operation. Requires placement.inspect revision. Preserves its live backend and project affinity; refuses the last grid pane in a project. Does not toggle Dispatch on.',
      input: session.extend({ revision: z.string() }), output: z.object({ sessionId: z.string(), detached: z.literal(true) }),
      handler: input => {
        ready(); const before = placement(input.sessionId)
        if (before.revision !== input.revision) throw new ControlError('stale_cursor', 'Placement changed; inspect again')
        if (!before.gridTabId || before.buried) throw new ControlError('unavailable', 'Choose a current grid pane')
        getWorkspace().detachSessionToDispatch(input.sessionId)
        if (!placement(input.sessionId).detached) throw new ControlError('unavailable', 'Detach refused; the last grid pane must remain')
        return { sessionId: input.sessionId, detached: true as const }
      },
    }),
    defineCapability({ id: 'agents.bury', title: 'Archive a grid pane without killing it', execution: 'window', effect: 'mutation', target: { kind: 'session', field: 'sessionId' },
      description: 'Bury the exact grid pane with an optional archive note through the existing non-destructive archive operation. Requires placement.inspect revision acknowledging affectedSessionIds: burying the last pane also archives detached children and removes the project tab. Backends remain alive. Use agents.restore for recovery; detached agents must be attached before burying.',
      input: session.extend({ revision: z.string(), note: z.string().max(4000).optional() }), output: z.object({ sessionId: z.string(), buriedSessionIds: z.array(z.string()) }),
      handler: input => {
        ready(); const before = placement(input.sessionId)
        if (before.revision !== input.revision) throw new ControlError('stale_cursor', 'Placement changed; inspect the affected sessions again')
        if (!before.gridTabId || before.buried) throw new ControlError('unavailable', 'Choose a current grid pane')
        getWorkspace().buryFocused(input.note, input.sessionId)
        const ids = useAppStore.getState().workspaceState.buried.map(row => row.sessionId).filter(id => before.affectedSessionIds.includes(id))
        if (!ids.includes(input.sessionId)) throw new ControlError('failed', 'Archive was not observed', 'unknown')
        return { sessionId: input.sessionId, buriedSessionIds: ids }
      },
    }),
    defineCapability({ id: 'views.agentSet', title: 'Show an agent in Reader or Spotlight', execution: 'window', effect: 'ui', target: { kind: 'session', field: 'sessionId' },
      description: 'Set an exact visible agent view to Reader, Spotlight or normal workspace. Uses desired state, not a toggle. Reader shows the conversation; Spotlight zooms its pane. Requires a current non-buried session. For normal workspace this exits focus views and navigates to the agent; use agents.show when staying in the current view mode.',
      input: session.extend({ mode: z.enum(['reader', 'spotlight', 'workspace']) }), output: z.object({ sessionId: z.string(), mode: z.string() }),
      handler: async input => {
        ready(); const before = placement(input.sessionId)
        if (before.buried) throw new ControlError('unavailable', 'Restore the buried agent first')
        const workspace = getWorkspace()
        let changed: boolean
        if (input.mode === 'reader') changed = workspace.setReaderModeTarget(input.sessionId)
        else {
          workspace.setReaderModeTarget(null)
          if (input.mode === 'spotlight') changed = workspace.setSpotlightTarget(input.sessionId)
          else { workspace.setSpotlightTarget(null); changed = await workspace.focusAgentBySessionId(input.sessionId) }
        }
        if (!changed) throw new ControlError('unavailable', 'The target does not support this view')
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
        const store = useAppStore.getState()
        const visible = input.mode === 'reader' ? store.workspaceReaderMode?.focusedSessionId === input.sessionId
          : input.mode === 'spotlight' ? store.workspaceSpotlight?.focusedSessionId === input.sessionId : !store.workspaceReaderMode && !store.workspaceSpotlight
        if (!visible || hasAppInteractionOwner()) throw new ControlError('failed', 'View changed during navigation; inspect app.observe', 'unknown')
        return { sessionId: input.sessionId, mode: input.mode }
      },
    }),
  ]
}
