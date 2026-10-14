import { createContext, useContext, useEffect } from 'react'

import { useAppStore } from '@renderer/app-state/store'

export type KeyboardRegion = 'workspace' | 'sidekick'

/**
 * Which keyboard region a subtree belongs to (#1493). Everything defaults to
 * the workspace; only the Sidekick panel provides 'sidekick' around its leaf.
 *
 * WHY a context and not a prop on the leaf: the leaf is rendered through
 * renderWorkspaceLeaf, shared with lanes and Spotlight, and the region has to
 * reach TileLeaf, AgentTerminalLeaf and TerminalLeaf alike. A context crosses
 * that boundary without a new parameter on a function every surface calls.
 */
export const KeyboardRegionContext = createContext<KeyboardRegion>('workspace')

/** True when the store says this subtree's region currently owns the keyboard. */
export function useKeyboardRegionActive(): boolean {
  const region = useContext(KeyboardRegionContext)
  return useAppStore(state => state.keyboardRegion === region)
}

/** The DOM marker of the Sidekick panel; see useKeyboardRegionFollowsPointer. */
export const SIDEKICK_PANEL_ATTRIBUTE = 'data-sidekick-panel'

/**
 * Keep the keyboard region where the user's pointer and focus actually go
 * (#1493). Mounted once per window by SidekickPanelSurface.
 *
 * WHY capture phase on document: a click into a lane must hand the keyboard
 * back to the workspace BEFORE the lane's own handlers decide whether they
 * are interactive. Events inside a dialog (the picker, a confirm) change
 * nothing — a modal is not a region, and closing it returns focus where it was.
 */
export function useKeyboardRegionFollowsPointer(): void {
  const setRegion = useAppStore(state => state.setKeyboardRegion)
  useEffect(() => {
    const onEvent = (event: Event) => {
      const target = event.target as Element | null
      if (!target || typeof target.closest !== 'function') return
      if (target.closest('[role="dialog"], [role="alertdialog"]')) return
      setRegion(target.closest(`[${SIDEKICK_PANEL_ATTRIBUTE}]`) ? 'sidekick' : 'workspace')
    }
    document.addEventListener('pointerdown', onEvent, true)
    document.addEventListener('focusin', onEvent, true)
    return () => {
      document.removeEventListener('pointerdown', onEvent, true)
      document.removeEventListener('focusin', onEvent, true)
    }
  }, [setRegion])
}
