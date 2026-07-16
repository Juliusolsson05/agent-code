import { useCallback } from 'react'

import { navigateToAgentIndexTarget } from '@renderer/workspace/agentIndexNavigation'
import { resolveAgentPaneLabel } from '@renderer/workspace/tile-tree/paneLabels'
import type {
  WorkspaceSetState,
  WorkspaceSetTileTabs,
} from '@renderer/workspace/hook/context'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import type { SessionActions } from '@renderer/workspace/hook/actions/session'

export function useAgentIndexNavigationActions(
  setState: WorkspaceSetState,
  setTileTabs: WorkspaceSetTileTabs,
  refs: WorkspaceRefs,
  sessionActions: SessionActions,
  showToast: (message: string, durationMs?: number) => void,
): {
  focusAgentByPaneLabel: (label: string) => Promise<boolean>
} {
  const focusAgentByPaneLabel = useCallback(
    async (label: string): Promise<boolean> => {
      const initialTarget = resolveAgentPaneLabel(refs.stateRef.current, label)
      if (!initialTarget) return false
      const initialResult = navigateToAgentIndexTarget(
        refs.stateRef.current,
        refs.latestTileTabsRef.current,
        initialTarget,
        Date.now(),
      )
      if (!initialResult) return false

      if (initialResult.requiresWake) {
        try {
          // Detached agents survive reload as metadata without a provider
          // process. Wake under the SAME SessionId before exposing one in a
          // lane/grid slot; otherwise the navigation appears to work but the
          // first keystroke lands on a dead backend. ensureSessionLive is also
          // safe for an already-running detached agent, so this single branch
          // covers both fresh and restored workspaces.
          await sessionActions.ensureSessionLive(initialTarget.sessionId)
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
        const currentTarget = resolveAgentPaneLabel(current, label)
        if (currentTarget?.sessionId !== initialTarget.sessionId) return current
        const result = navigateToAgentIndexTarget(
          current,
          refs.latestTileTabsRef.current,
          currentTarget,
          Date.now(),
        )
        if (!result) return current
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

  return { focusAgentByPaneLabel }
}
