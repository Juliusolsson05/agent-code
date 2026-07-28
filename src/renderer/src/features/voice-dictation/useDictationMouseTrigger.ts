import { useEffect } from 'react'

import { useAppStore } from '@renderer/app-state/hooks'
import { MOUSE_BUTTON_BINDINGS, MOUSE_BUTTON_MASKS } from '@renderer/lib/mouseBinding'
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
    const bound = dictationMouseButton as Exclude<MouseButtonBinding, ''>
    const boundButton = MOUSE_BUTTON_BINDINGS[bound]
    const boundMask = MOUSE_BUTTON_MASKS[bound]
    // '' (off) and any value that survived coercion but is not a bindable
    // button both land here. Never install listeners for an unbound button:
    // the handlers preventDefault, so a wrong bound value would silently eat
    // a mouse gesture app-wide.
    if (boundButton === undefined || boundMask === undefined) return

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

    const onDown = (event: MouseEvent): void => {
      if (event.button !== boundButton) return
      // The bound button is RESERVED. Suppressing both the default action and
      // further propagation is what keeps middle-click out of xterm's
      // X11-style paste and the side buttons out of Chromium's history
      // navigation. Canceling `pointerdown` also suppresses the compatibility
      // `mousedown`, so DOM listeners downstream never see the press either.
      //
      // stopPropagation, NOT stopImmediatePropagation: MouseButtonInput's
      // capture listener sits on this same node (window), and it must still
      // fire or the user could never re-bind the button that is already bound.
      event.preventDefault()
      event.stopPropagation()
      if (holding) return
      holding = true
      beginDictationHold('mouse')
    }

    /**
     * Release when the bound button is no longer held — testing the `buttons`
     * bitmask, NEVER `event.button`.
     *
     * This is the fix for a real stuck-microphone bug, confirmed against
     * hardware. For a mouse there is one pointer, so `pointerup` fires only
     * when the LAST button comes up and carries whichever button that was:
     *
     *   hold middle (dictation starts) -> click left -> release middle
     *     ...no pointerup at all; the recording continues
     *   release left
     *     ...pointerup arrives with button 0
     *
     * The old `event.button !== boundButton` guard rejected that release and
     * the microphone stayed open until the window lost focus. `buttons`
     * reflects post-release state, so this is correct regardless of which
     * button the event claims to be about.
     */
    const onUp = (event: MouseEvent): void => {
      if (!holding) return
      if ((event.buttons & boundMask) !== 0) return
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

    // WHY this many listeners — a stuck-open microphone is the worst failure
    // this subsystem has, and a mouse button can miss its up edge in ways a
    // key cannot.
    //
    // Down needs BOTH pointerdown and mousedown. `pointerdown` fires only on
    // the 0 -> non-zero transition, so pressing the bound button while any
    // other button is already held emits mousedown and no pointerdown at all.
    // (The reverse duplicate is harmless: cancelling pointerdown suppresses
    // the compat mousedown, and `holding` makes the handler idempotent
    // regardless.)
    //
    // Up needs pointerup, mouseup, pointercancel, blur and visibilitychange:
    // the pointer can leave the window while held, the window can lose focus
    // mid-hold (Cmd+Tab), the browser can cancel the pointer stream, and a
    // mid-hold release of the bound button emits only mouseup. All five
    // funnel into one idempotent release. A truncated dictation is
    // recoverable; a recording that never stops is not.
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('pointerup', onUp, true)
    window.addEventListener('mouseup', onUp, true)
    window.addEventListener('pointercancel', release, true)
    window.addEventListener('auxclick', onAuxClick, true)
    window.addEventListener('blur', release)
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      // Drain before unbinding, so changing or clearing the binding mid-hold
      // cannot orphan a recording whose up edge will never be delivered —
      // the same hazard `releaseElectronHotkeyRecording` exists to prevent on
      // the keyboard side.
      //
      // Deliberately NOT claimed for the dictation-disabled case: that also
      // re-runs useComposerDictation's registration effect, and by the time
      // this cleanup runs the targets may already be unregistered, leaving
      // endDictationHold with nothing to stop. useComposerDictation cancels
      // its own recording on `enabled -> false` independently, which is what
      // actually covers that path.
      release()
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('pointerup', onUp, true)
      window.removeEventListener('mouseup', onUp, true)
      window.removeEventListener('pointercancel', release, true)
      window.removeEventListener('auxclick', onAuxClick, true)
      window.removeEventListener('blur', release)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [dictationEnabled, dictationMouseButton])
}
