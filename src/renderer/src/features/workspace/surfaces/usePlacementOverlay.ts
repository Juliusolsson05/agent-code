import { useCallback } from 'react'
import { useAppStore } from '@renderer/app-state/hooks'

// Create, attach, and linked-agent flows share the same overlay
// shell. The close handler clears every intent so re-opening one
// mode after another never inherits stale state from a sibling flow.
// (Derivation extracted from App.tsx by #494; consumed by
// app/shell/MainSurface which renders NewAgentPlacementOverlay inside
// the tile-tree / dispatch relative container — it can NOT be a
// root-level registry surface because its positioning is relative to
// the main layout, not the viewport.)
export function usePlacementOverlay(): {
  open: boolean
  attachIntent: ReturnType<typeof useAppStore.getState>['dispatchAttachIntent']
  linkedAgentParentId: ReturnType<typeof useAppStore.getState>['linkedAgentParentId']
  projectIntent: ReturnType<typeof useAppStore.getState>['newAgentProjectIntent']
  close: () => void
} {
  const newAgentPlacementOpen = useAppStore(state => state.newAgentPlacementOpen)
  const attachIntent = useAppStore(state => state.dispatchAttachIntent)
  const linkedAgentParentId = useAppStore(state => state.linkedAgentParentId)
  // Note: this intent does NOT contribute to `open` below. It only ever
  // accompanies newAgentPlacementOpen (openNewAgentForProject sets both), so
  // treating it as its own opener would let a stale intent resurrect the
  // overlay. closeNewAgentPlacement clears it.
  const projectIntent = useAppStore(state => state.newAgentProjectIntent)
  const closeNewAgentPlacement = useAppStore(state => state.closeNewAgentPlacement)
  const closeDispatchAttach = useAppStore(state => state.closeDispatchAttach)
  const closeLinkedAgent = useAppStore(state => state.closeLinkedAgent)
  const close = useCallback(() => {
    closeNewAgentPlacement()
    closeDispatchAttach()
    closeLinkedAgent()
  }, [closeDispatchAttach, closeLinkedAgent, closeNewAgentPlacement])
  return {
    open: newAgentPlacementOpen || attachIntent !== null || linkedAgentParentId !== null,
    attachIntent,
    linkedAgentParentId,
    projectIntent,
    close,
  }
}
