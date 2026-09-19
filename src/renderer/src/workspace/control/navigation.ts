import { z } from 'zod'
import { ControlError, defineCapability } from '@control-sdk'
import { useAppStore } from '@renderer/app-state/store'
import { hasAppInteractionOwner } from '@renderer/lib/interaction-ownership'
import { observeWorkspace } from '@renderer/workspace/control'
import type { Workspace } from '@renderer/workspace/hook'

// placement.inspect, placement.detach and agents.bury lived here until the
// unified layout (#992). They moved grid panes to Dispatch or archived them;
// in the pool-first workspace there is no grid to detach from and no archive
// to bury into — a session not shown in a lane is simply an unplaced pool
// row. Operators show a session with agents.show or dispatch.configure
// (lane-select) and hide it by selecting another session into that lane.

const session = z.object({ sessionId: z.string().min(1) }).strict()
export function navigationControlCapabilities(getWorkspace: () => Workspace) {
  const ready = () => {
    if (getWorkspace().restoreStatus === 'pending' || hasAppInteractionOwner()) throw new ControlError('unavailable', 'Wait for restoration or finish the input-owning surface')
  }
  const requireSession = (sessionId: string) => {
    const state = useAppStore.getState().workspaceState
    if (!state.sessions[sessionId]) throw new ControlError('unavailable', 'Session no longer exists')
  }
  return [
    defineCapability({ id: 'views.agentSet', title: 'Show an agent in Reader or Spotlight', execution: 'window', effect: 'ui', target: { kind: 'session', field: 'sessionId' },
      description: 'Set an exact visible agent view to Reader, Spotlight or normal workspace. Uses desired state, not a toggle. Reader shows the conversation; Spotlight zooms its pane. Requires a current session. For normal workspace this exits focus views and navigates to the agent; use agents.show when staying in the current view mode.',
      input: session.extend({ mode: z.enum(['reader', 'spotlight', 'workspace']) }), output: z.object({ sessionId: z.string(), mode: z.string() }),
      handler: async input => {
        ready(); requireSession(input.sessionId)
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
          : input.mode === 'spotlight' ? store.workspaceSpotlight?.focusedSessionId === input.sessionId : !store.workspaceReaderMode && !store.workspaceSpotlight && observeWorkspace(getWorkspace).focusedSessionId === input.sessionId
        if (!visible || hasAppInteractionOwner()) throw new ControlError('failed', 'View changed during navigation; inspect app.observe', 'unknown')
        return { sessionId: input.sessionId, mode: input.mode }
      },
    }),
  ]
}
