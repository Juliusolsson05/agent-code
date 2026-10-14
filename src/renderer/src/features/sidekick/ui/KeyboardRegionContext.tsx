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
 * Portalled surfaces that are not a region of their own. Review round 1 added
 * the menu role and Radix's popper wrapper (not `listbox`: lanes render inline
 * listboxes, and a click on one must still hand the lane the keyboard): a context menu or select
 * opened FROM the panel renders under <body>, outside the panel's DOM, so a
 * click on one of its items used to flip the region to 'workspace' mid-gesture
 * — and the item's action then ran with the lane owning the keyboard.
 */
export const REGION_NEUTRAL_SELECTOR = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[data-radix-popper-content-wrapper]',
  // A resize handle is not a place to type. Dragging the Sidekick's boundary
  // (or any lane split) must not move the keyboard between regions; the
  // Sidekick's handle sits inside the panel's marked DOM, so without this a
  // resize silently took the keyboard away from the lane being typed in.
  '[role="separator"]',
].join(', ')

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
      if (target.closest(REGION_NEUTRAL_SELECTOR)) return
      const inSidekick = target.closest(`[${SIDEKICK_PANEL_ATTRIBUTE}]`) !== null
      // While the Sidekick is spotlit the lanes are hidden: a click on app
      // chrome (tab bar, Settings bar, a side panel) is not the user choosing
      // a lane, and handing the keyboard to hidden lanes let ⌘W close one of
      // them (#1513 review). The region stays with the Sidekick until its
      // Spotlight ends.
      const state = useAppStore.getState()
      if (!inSidekick && state.sidekickSpotlight && !state.settingsPageOpen) return
      setRegion(inSidekick ? 'sidekick' : 'workspace')
    }
    document.addEventListener('pointerdown', onEvent, true)
    document.addEventListener('focusin', onEvent, true)
    return () => {
      document.removeEventListener('pointerdown', onEvent, true)
      document.removeEventListener('focusin', onEvent, true)
    }
  }, [setRegion])
}
