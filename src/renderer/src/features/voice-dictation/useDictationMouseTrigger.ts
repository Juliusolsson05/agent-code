import { useEffect } from 'react'

import { useAppStore } from '@renderer/app-state/hooks'
import { MOUSE_BUTTON_BINDINGS } from '@renderer/lib/mouseBinding'
import type { MouseButtonBinding } from '@renderer/lib/mouseBinding'
import {
  beginDictationHold,
  endDictationHold,
} from '@renderer/workspace/tile-tree/TileLeaf/dictationHotkeyRegistry'

/**
 * Hold-to-talk on a mouse button, for the in-app case.
 *
 * WHY this is a renderer listener and not an extension of the main-process
 * hotkey path: Electron's `globalShortcut` cannot register mouse buttons at
 * all, so a global mouse trigger would have to go through the CGEventTap
 * helper — which means the Accessibility permission and a macOS-only
 * feature. The product decision was that dictation targets an Agent Code
 * composer, so capture only needs to work while Agent Code is focused. That
 * makes this a DOM listener with no permission, no native code, and no
 * platform gate.
 *
 * The upside over the keyboard path: pointer events carry REAL down and up
 * edges. `globalShortcut` has no key-up callback, which is why the quiet
 * keyboard path in main is a toggle rather than hold-to-talk (see the WHY on
 * `releaseElectronHotkeyRecording` in main/dictation/hotkey.ts). The mouse
 * trigger is genuine hold-to-talk.
 */
export function useDictationMouseTrigger(): void {
  const dictationEnabled = useAppStore(state => state.settings.dictationEnabled)
  const dictationMouseButton = useAppStore(state => state.settings.dictationMouseButton)

  useEffect(() => {
    if (!dictationEnabled) return
    const boundButton =
      MOUSE_BUTTON_BINDINGS[dictationMouseButton as Exclude<MouseButtonBinding, ''>]
    // '' (off) and any value that survived coercion but is not a bindable
    // button both land here. Never install listeners for an unbound button:
    // the handlers preventDefault, so a wrong bound value would silently eat
    // a mouse gesture app-wide.
    if (boundButton === undefined) return

    // Hold state is a plain closure variable, not React state, for the same
    // reason `useComposerDictation` keeps lifecycle in refs: down and up are
    // raw DOM events that can arrive in the same frame, and a state update
    // scheduled by the down would not be visible to the up. This must be
    // synchronous.
    let holding = false

    /**
     * The single release funnel. Idempotent by the `holding` guard, because
     * several of the paths below can legitimately fire for the same hold —
     * e.g. blur and pointerup both arrive when the user releases over another
     * window.
     */
    const release = (): void => {
      if (!holding) return
      holding = false
      endDictationHold()
    }

    const onPointerDown = (event: PointerEvent): void => {
      if (event.button !== boundButton) return
      // The bound button is RESERVED. Suppressing both the default action and
      // further propagation is what keeps middle-click out of xterm's
      // X11-style paste and the side buttons out of Chromium's history
      // navigation. Canceling `pointerdown` also suppresses the compatibility
      // `mousedown`, so DOM listeners downstream never see the press either.
      event.preventDefault()
      event.stopPropagation()
      if (holding) return
      holding = true
      beginDictationHold()
    }

    const onPointerUp = (event: PointerEvent): void => {
      if (event.button !== boundButton) return
      event.preventDefault()
      event.stopPropagation()
      release()
    }

    // `auxclick` fires for non-primary buttons AFTER the pointer pair and is
    // the event Chromium actually routes to history navigation and
    // open-in-new-tab. Canceling pointerdown does not reliably suppress it,
    // so it gets its own suppressor.
    const onAuxClick = (event: MouseEvent): void => {
      if (event.button !== boundButton) return
      event.preventDefault()
      event.stopPropagation()
    }

    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'hidden') release()
    }

    // WHY four release paths instead of just pointerup:
    //
    // A stuck-open microphone is the worst failure this subsystem has, and
    // the native helper carries a paragraph about exactly this for Fn. A
    // mouse button adds THREE ways to miss the up edge that a key does not
    // have: the pointer can leave the window while held (pointerup lands on
    // another window), the window can lose focus mid-hold (Cmd+Tab), and the
    // browser can cancel the pointer stream outright. Each of those gets a
    // path to `release()`. A truncated dictation is recoverable; a recording
    // that never stops is not.
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('pointerup', onPointerUp, true)
    window.addEventListener('pointercancel', release, true)
    window.addEventListener('auxclick', onAuxClick, true)
    window.addEventListener('blur', release)
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      // Drain before unbinding. If the user changes or clears the binding
      // (or disables dictation) while holding, the up edge for the OLD
      // binding will never be delivered to anyone — same orphan-recording
      // hazard that `releaseElectronHotkeyRecording` exists to prevent on
      // the keyboard side.
      release()
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('pointerup', onPointerUp, true)
      window.removeEventListener('pointercancel', release, true)
      window.removeEventListener('auxclick', onAuxClick, true)
      window.removeEventListener('blur', release)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [dictationEnabled, dictationMouseButton])
}
