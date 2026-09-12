import { useCallback } from 'react'

import { navigateToAgentIndexTarget } from '@renderer/workspace/agentIndexNavigation'
import type { AgentIndexNavigationIntent } from '@renderer/workspace/agentIndexNavigation'
import { resolveAgentPaneLabel, resolveAgentSessionTarget } from '@renderer/workspace/tile-tree/paneLabels'
import type {
  WorkspaceSetState,
  WorkspaceSetTileTabs,
} from '@renderer/workspace/hook/context'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import type { AgentPaneLabelTarget } from '@renderer/workspace/tile-tree/paneLabels'
import type { WorkspaceState, TileTabsState } from '@renderer/workspace/types'
import type { SessionActions } from '@renderer/workspace/hook/actions/session'

export function useAgentIndexNavigationActions(
  setState: WorkspaceSetState,
  setTileTabs: WorkspaceSetTileTabs,
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
      resolve: (state: WorkspaceState, tileTabs: TileTabsState | null) => AgentPaneLabelTarget | null,
      intent: AgentIndexNavigationIntent = 'reuse-existing-view',
    ): Promise<boolean> => {
      const initialTarget = resolve(refs.stateRef.current, refs.latestTileTabsRef.current)
      if (!initialTarget) return false
      const initialResult = navigateToAgentIndexTarget(
        refs.stateRef.current,
        refs.latestTileTabsRef.current,
        initialTarget,
        intent,
      )
      if (!initialResult) return false
      const destination = (state: WorkspaceState, tiled: TileTabsState | null) => JSON.stringify([
        tiled?.focusedTabId ?? state.activeTabId,
        state.tabs.find(tab => tab.id === (tiled?.focusedTabId ?? state.activeTabId))?.focusedSessionId,
        state.dispatchMode?.tiled?.focusedLane,
      ])
      const initialDestination = destination(refs.stateRef.current, refs.latestTileTabsRef.current)

      if (initialResult.requiresWake) {
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
      let nextTileTabs = refs.latestTileTabsRef.current
      setState(current => {
        // Re-resolve at commit time because the label is positional. A close,
        // detach, or tab reorder can change what "A2" means while a hibernated
        // target is waking. Never redirect the user's already-confirmed action
        // to a different session just because that new session inherited the
        // coordinate during the await.
        const currentTarget = resolve(current, refs.latestTileTabsRef.current)
        if (currentTarget?.sessionId !== initialTarget.sessionId) return current
        const result = navigateToAgentIndexTarget(
          current,
          refs.latestTileTabsRef.current,
          currentTarget,
          intent,
        )
        if (!result) return current
        // A wake can take seconds. Replacing a slot is meaningful only for the
        // slot captured when navigation began; focus moving meanwhile must not
        // silently repurpose the user's newly focused pane or Dispatch lane.
        if ((result.kind.startsWith('replace-') || result.kind.startsWith('swap-'))
          && destination(current, refs.latestTileTabsRef.current) !== initialDestination) return current
        committed = true
        nextTileTabs = result.tileTabs
        return result.state
      })

      if (!committed) {
        showToast(`Agent index ${initialTarget.label} changed; open the command palette again`)
        return false
      }
      // Workspace layout and meta-tab layout live in separate Zustand slices.
      // Commit the workspace first so TileTabs never renders a newly inserted
      // tab id against the old focusedSessionId for even one state turn.
      setTileTabs(nextTileTabs)
      return true
    },
    [refs.latestTileTabsRef, refs.stateRef, sessionActions, setState, setTileTabs, showToast],
  )

  // Both UI coordinates and stable SDK targets use the same wake/commit path.
  // The label resolver retains its positional race guard; the ID resolver can
  // survive a reorder without turning that coordinate into a different agent.
  const focusAgentByPaneLabel = useCallback((label: string, intent?: AgentIndexNavigationIntent) =>
    focusTarget((state, tileTabs) => resolveAgentPaneLabel(state, label, tileTabs), intent), [focusTarget])
  const focusAgentBySessionId = useCallback((sessionId: string, intent?: AgentIndexNavigationIntent) =>
    focusTarget(state => resolveAgentSessionTarget(state, sessionId), intent), [focusTarget])
  return { focusAgentByPaneLabel, focusAgentBySessionId }
}
