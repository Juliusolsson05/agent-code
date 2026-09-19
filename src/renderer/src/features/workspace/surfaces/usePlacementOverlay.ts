import { useCallback } from 'react'
import { useAppStore } from '@renderer/app-state/hooks'

// Create and linked-agent flows share the same overlay shell. The close
// handler clears both intents so re-opening one mode after another never
// inherits stale state from a sibling flow. (Derivation extracted from
// App.tsx by #494; consumed by app/shell/MainSurface which renders
// NewAgentPlacementOverlay inside the stage's relative container — it can
// NOT be a root-level registry surface because its positioning is relative
// to the main layout, not the viewport.)
//
// The attach-detached flow used to be the third mode here. It died with the
// tile tree (#992): there is no grid to attach into, and placing a pool
// session on screen is a lane selection, not an overlay.
export function usePlacementOverlay(): {
  open: boolean
  linkedAgentParentId: ReturnType<typeof useAppStore.getState>['linkedAgentParentId']
  projectIntent: ReturnType<typeof useAppStore.getState>['newAgentProjectIntent']
  close: () => void
} {
  const newAgentPlacementOpen = useAppStore(state => state.newAgentPlacementOpen)
  const linkedAgentParentId = useAppStore(state => state.linkedAgentParentId)
  // Note: this intent does NOT contribute to `open` below. It only ever
  // accompanies newAgentPlacementOpen (openNewAgentForProject sets both), so
  // treating it as its own opener would let a stale intent resurrect the
  // overlay. closeNewAgentPlacement clears it.
  const projectIntent = useAppStore(state => state.newAgentProjectIntent)
  const closeNewAgentPlacement = useAppStore(state => state.closeNewAgentPlacement)
  const closeLinkedAgent = useAppStore(state => state.closeLinkedAgent)
  const close = useCallback(() => {
    closeNewAgentPlacement()
    closeLinkedAgent()
  }, [closeLinkedAgent, closeNewAgentPlacement])
  return {
    open: newAgentPlacementOpen || linkedAgentParentId !== null,
    linkedAgentParentId,
    projectIntent,
    close,
  }
}
