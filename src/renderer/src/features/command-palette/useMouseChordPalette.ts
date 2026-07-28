import { useEffect } from 'react'

import { useAppStore } from '@renderer/app-state/hooks'
import { hasAppInteractionOwner } from '@renderer/lib/interaction-ownership'
import { MOUSE_CHORD_ANCHOR_MASKS, MOUSE_CHORD_MASKS } from '@renderer/lib/mouseBinding'
import type { MouseChordBinding } from '@renderer/lib/mouseBinding'
import { registerChordConsumer } from '@renderer/lib/mouseArbiter'

/**
 * Open the command palette with a mouse chord.
 *
 * WHY this feature is not a convenience: the command palette currently cannot
 * be opened with a mouse AT ALL. `openCommandPalette` has exactly one caller —
 * the `open-command-palette` command — routed only from Cmd+Shift+P, and the
 * native macOS menu exposes six of the catalog's 98 commands. So roughly sixty
 * commands have no pointer path, and the container that would reach them is
 * itself keyboard-gated. This chord is the door.
 *
 * WHY the direct store action instead of `requestCommandInvocation`: the
 * command-routed path mounts the whole `OpenCommandPalette` host (~76 context
 * values) purely to reach the same store setter, which is exactly the cost
 * #494 was about avoiding. Nothing about routing through the command gateway
 * would add behavior here.
 */
export function useMouseChordPalette(): void {
  const paletteMouseChord = useAppStore(state => state.settings.paletteMouseChord)
  const openCommandPalette = useAppStore(state => state.openCommandPalette)

  useEffect(() => {
    const chord = paletteMouseChord as Exclude<MouseChordBinding, ''>
    const mask = MOUSE_CHORD_MASKS[chord]
    const anchorMask = MOUSE_CHORD_ANCHOR_MASKS[chord]
    if (mask === undefined || anchorMask === undefined) return

    return registerChordConsumer({
      mask,
      anchorMask,
      onFire: () => {
        // Same ownership contract as every other non-DOM input path: a modal
        // surface owns input while it is up. The deliberate exception is the
        // palette itself — it sets the interaction-owner marker, so consulting
        // the gate unconditionally would make the chord unable to reach the
        // palette while the palette is open, which is the one case where a
        // second chord press is most plausible. Mirrors the
        // `commandOwnsOpenSurface` exemption the keybinding router uses.
        const paletteOpen = useAppStore.getState().commandPaletteOpen
        if (!paletteOpen && hasAppInteractionOwner()) return
        // Note the semantics: this is idempotent when the palette is already
        // in its default mode, but resets an open SUB-MODE back to the command
        // list. That is deliberate upstream behavior ("reopening should never
        // resume a half-finished sub-flow"), and it is the right thing for a
        // chord too — the gesture means "take me to the command list".
        openCommandPalette()
      },
    })
  }, [paletteMouseChord, openCommandPalette])
}
