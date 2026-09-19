import { useCallback } from 'react'

import { navigateToAgentIndexTarget } from '@renderer/workspace/agentIndexNavigation'
import type { AgentIndexNavigationIntent } from '@renderer/workspace/agentIndexNavigation'
import { resolveAgentPaneLabel, resolveAgentSessionTarget } from '@renderer/workspace/tile-tree/paneLabels'
import type { WorkspaceSetRuntimes, WorkspaceSetState } from '@renderer/workspace/hook/context'
import { clearPooledSpawnBadge } from '@renderer/workspace/hook/actions/pooledSpawnBadge'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import type { AgentPaneLabelTarget } from '@renderer/workspace/tile-tree/paneLabels'
import type { WorkspaceState } from '@renderer/workspace/types'
import type { SessionActions } from '@renderer/workspace/hook/actions/session'

export function useAgentIndexNavigationActions(
  setState: WorkspaceSetState,
  setRuntimes: WorkspaceSetRuntimes,
  refs: WorkspaceRefs,
  sessionActions: SessionActions,
  showToast: (message: string, durationMs?: number) => void,
): {
  focusAgentBySessionId: (sessionId: string, intent?: AgentIndexNavigationIntent) => Promise<boolean>
  focusAgentByPaneLabel: (
    label: string,
    intent?: AgentIndexNavigationIntent,
  ) => Promise<boolean>
} {
  const focusTarget = useCallback(
    async (
      resolve: (state: WorkspaceState) => AgentPaneLabelTarget | null,
      intent: AgentIndexNavigationIntent = 'reuse-existing-view',
    ): Promise<boolean> => {
      const initialTarget = resolve(refs.stateRef.current)
      if (!initialTarget) return false
      const initialResult = navigateToAgentIndexTarget(
        refs.stateRef.current,
        initialTarget,
        intent,
      )
      if (!initialResult) return false
      // The destination a `replace-` result would overwrite: the focused
      // lane of the active project. (It used to include the grid's focused
      // pane and the Tile Tabs slot; both died with #992.)
      const destination = (state: WorkspaceState) => JSON.stringify([
        state.activeTabId,
        state.stage.focusedLane,
      ])
      const initialDestination = destination(refs.stateRef.current)

      // Wake unless the runtime says a backend is already up. A parked session
      // survives a restart as metadata with no provider process, and exposing
      // one in a lane un-woken means the first keystroke lands on a dead
      // backend (#690). 'started' is the only status that proves otherwise;
      // 'idle', 'failed' and 'exited' all need the wake path, which is also
      // the retry path. (Until #992 the test was "has a detachedSessions
      // record", a structural stand-in for this.)
      const processStatus = refs.latestRuntimesRef.current[initialTarget.sessionId]?.processStatus
      if (processStatus !== 'started') {
        try {
          // Detached agents survive reload as metadata without a provider
          // process. Wake under the SAME SessionId before exposing one in a
          // lane/grid slot; otherwise the navigation appears to work but the
          // first keystroke lands on a dead backend. ensureSessionLive is also
          // safe for an already-running detached agent, so this single branch
          // covers both fresh and restored workspaces.
          await sessionActions.ensureSessionLive(initialTarget.sessionId, 'agent-index.navigate')
        } catch (error) {
          showToast(
            error instanceof Error && error.message.length > 0
              ? error.message
              : `Could not wake agent ${initialTarget.label}`,
          )
          return false
        }
      }

      let committed = false
      setState(current => {
        // Re-resolve at commit time because the label is positional. A close,
        // detach, or tab reorder can change what "A2" means while a hibernated
        // target is waking. Never redirect the user's already-confirmed action
        // to a different session just because that new session inherited the
        // coordinate during the await.
        const currentTarget = resolve(current)
        if (currentTarget?.sessionId !== initialTarget.sessionId) return current
        const result = navigateToAgentIndexTarget(
          current,
          currentTarget,
          intent,
        )
        if (!result) return current
        // A wake can take seconds. Replacing a slot is meaningful only for the
        // slot captured when navigation began; focus moving meanwhile must not
        // silently repurpose the user's newly focused pane or Dispatch lane.
        if (result.kind.startsWith('replace-')
          && destination(current) !== initialDestination) return current
        committed = true
        return result.state
      })

      if (!committed) {
        showToast(`Agent index ${initialTarget.label} changed; open the command palette again`)
        return false
      }
      // The session is on screen now, so its "new" badge has been answered
      // (pooledSpawnBadge.ts).
      clearPooledSpawnBadge(setRuntimes, initialTarget.sessionId)
      return true
    },
    [refs.stateRef, sessionActions, setRuntimes, setState, showToast],
  )

  // Both UI coordinates and stable SDK targets use the same wake/commit path.
  // The label resolver retains its positional race guard; the ID resolver can
  // survive a reorder without turning that coordinate into a different agent.
  const focusAgentByPaneLabel = useCallback((label: string, intent?: AgentIndexNavigationIntent) =>
    focusTarget(state => resolveAgentPaneLabel(state, label), intent), [focusTarget])
  const focusAgentBySessionId = useCallback((sessionId: string, intent?: AgentIndexNavigationIntent) =>
    focusTarget(state => resolveAgentSessionTarget(state, sessionId), intent), [focusTarget])
  return { focusAgentByPaneLabel, focusAgentBySessionId }
}
