import { create } from 'zustand'

import type { HoldEndReason } from '@shared/types/tldr'

// Preview state is deliberately outside persisted Settings/workspace state.
// Restarting the renderer while a key is held must never restore a darkened UI.
//
// `preview` says WHICH peek is showing. TLDR (Cmd+L) and Goal (Cmd+G, #936)
// share one hold gesture, one native release watcher, and one input gate: two
// independent stores would let both overlays be up at once and give Escape two
// things to dismiss.
export type PreviewKind = 'tldr' | 'goal'
export const useTldrView = create<{ held: boolean; latched: boolean; preview: PreviewKind }>(() => ({ held: false, latched: false, preview: 'tldr' }))
export function dismissTldr(): void { useTldrView.setState({ held: false, latched: false }) }
export function isPreviewVisible(state: { held: boolean; latched: boolean; preview: PreviewKind }, preview: PreviewKind): boolean {
  return (state.held || state.latched) && state.preview === preview
}
export function toggleTldr(preview: PreviewKind = 'tldr'): void {
  // Asking for the OTHER preview switches to it instead of closing: with TLDR
  // latched, choosing Goal means "show me goals", not "dismiss".
  const showing = isPreviewVisible(useTldrView.getState(), preview)
  useTldrView.setState({ held: false, latched: !showing, preview })
}

type HoldEvent = Pick<KeyboardEvent, 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'repeat'>

export function observeTldrHoldRelease(
  event: HoldEvent,
  release: (reason: HoldEndReason) => void,
): () => void {
  if (!event.metaKey) return () => {}
  const token = crypto.randomUUID()
  const unsubscribe = window.api.onTldrHoldReleased((released, reason) => {
    if (released === token) release(reason)
  })
  window.api.startTldrHold(event.code, token)
  return () => { unsubscribe(); window.api.stopTldrHold(token) }
}

/** Resolve the chord through the normal binding table before calling start.
 * Remember the physical key and modifiers that actually began this hold, not
 * Cmd+L literals: rebinding in Settings must change both press AND release. */
export function createTldrHoldController(
  setHeld = (held: boolean, preview: PreviewKind = 'tldr') =>
    useTldrView.setState(held ? { held, latched: false, preview } : { held, latched: false }),
  observeRelease: (event: HoldEvent, release: (reason: HoldEndReason) => void) => () => void = () => () => {},
  // Keep the peek up and dismissible when the key cannot be watched (#1066).
  setLatched = (preview: PreviewKind) => useTldrView.setState({ held: false, latched: true, preview }),
) {
  let gesture: HoldEvent | null = null
  let stopObserving: (() => void) | null = null
  let preview: PreviewKind = 'tldr'
  const release = (reason: HoldEndReason = 'released') => {
    if (!gesture) return
    gesture = null
    stopObserving?.()
    stopObserving = null
    // ── WHY AN UNOBSERVABLE HOLD LATCHES INSTEAD OF CLOSING (#1066) ──
    // The native watcher cannot see the keyboard, so nothing will ever tell us
    // the key came up. Clearing here is what produced the reported bug: the
    // peek flashed and vanished the instant it opened, indistinguishable from
    // a broken feature.
    //
    // Latching is safe where hanging would not be. This is the SAME state the
    // Goal/TLDR command produces every day: Escape dismisses it, the command
    // toggles it, and the overlay's input gate is unchanged. The invariant
    // holdRelease.ts protects — never leave an opaque overlay with no way out
    // — still holds, which is why the fix lives here rather than in the
    // watcher's "every exit ends the hold" rule.
    if (reason === 'unobservable') setLatched(preview)
    else setHeld(false)
  }
  return {
    start(event: HoldEvent, nextPreview: PreviewKind = 'tldr') {
      if (event.repeat || gesture) return
      gesture = { code: event.code, metaKey: event.metaKey, ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey, repeat: false }
      preview = nextPreview
      setHeld(true, nextPreview)
      stopObserving = observeRelease(gesture, release)
    },
    keyUp(event: Pick<KeyboardEvent, 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>) {
      if (!gesture) return
      if (event.code === gesture.code || (gesture.metaKey && !event.metaKey)
        || (gesture.ctrlKey && !event.ctrlKey) || (gesture.altKey && !event.altKey)
        || (gesture.shiftKey && !event.shiftKey)) release()
    },
    release,
  }
}
