import { useEffect } from 'react'

import { useAppStore } from '@renderer/app-state/hooks'
import { MOUSE_BUTTON_MASKS } from '@renderer/lib/mouseBinding'
import type { MouseButtonBinding } from '@renderer/lib/mouseBinding'
import { registerHoldConsumer } from '@renderer/lib/mouseArbiter'
import {
  beginDictationHold,
  cancelDictationHold,
  endDictationHold,
} from '@renderer/workspace/tile-tree/TileLeaf/dictationHotkeyRegistry'

/**
 * Hold-to-talk on a mouse button, for the in-app case.
 *
 * WHY this is a renderer listener and not an extension of the main-process
 * hotkey path: Electron's `globalShortcut` cannot register mouse buttons at
 * all, so a global mouse trigger would have to go through the CGEventTap
 * helper — which means the Accessibility permission and a macOS-only feature.
 * The product decision was that dictation targets an Agent Code composer, so
 * capture only needs to work while Agent Code is focused. That makes this a
 * DOM listener with no permission, no native code, and no platform gate.
 *
 * The upside over the keyboard path: pointer events carry REAL down and up
 * edges. `globalShortcut` has no key-up callback, which is why the quiet
 * keyboard path in main is a toggle rather than hold-to-talk (see the WHY on
 * `releaseElectronHotkeyRecording` in main/dictation/hotkey.ts). The mouse
 * trigger is genuine hold-to-talk.
 *
 * WHY the DOM listeners are no longer here: this hook used to install its own
 * window-capture listeners, which made a second global mouse gesture
 * structurally impossible. Capture listeners fire in registration order and
 * this hook mounts at App root, so it swallowed the bound button's mousedown
 * before anything registered later could see it — a palette chord sharing that
 * button would simply never have fired, silently. `lib/mouseArbiter.ts` now
 * owns every window mouse listener and decides which gesture won; read its
 * header before adding a third one.
 */
export function useDictationMouseTrigger(): void {
  const dictationEnabled = useAppStore(state => state.settings.dictationEnabled)
  const dictationMouseButton = useAppStore(state => state.settings.dictationMouseButton)

  useEffect(() => {
    if (!dictationEnabled) return
    const boundMask =
      MOUSE_BUTTON_MASKS[dictationMouseButton as Exclude<MouseButtonBinding, ''>]
    // '' (off) and any value that survived coercion but is not a bindable
    // button both land here. Never register for an unbound button: the arbiter
    // suppresses on match, so a wrong mask would silently eat a mouse gesture
    // app-wide.
    if (boundMask === undefined) return

    // Unregistering drains an in-flight hold (see registerHoldConsumer), which
    // is what keeps a binding change mid-hold from orphaning a recording —
    // the same hazard `releaseElectronHotkeyRecording` prevents on the
    // keyboard side.
    return registerHoldConsumer({
      mask: boundMask,
      onPress: () => beginDictationHold('mouse'),
      onRelease: () => endDictationHold(),
      // A chord claimed the gesture. DISCARD rather than transcribe: the user
      // meant to open the palette, not to dictate, and completing the hold
      // would ship a fragment of audio to the provider and paste it into a
      // composer.
      onCancel: () => cancelDictationHold(),
    })
  }, [dictationEnabled, dictationMouseButton])
}
