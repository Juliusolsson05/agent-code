import { create } from 'zustand'

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

export function observeTldrHoldRelease(event: HoldEvent, release: () => void): () => void {
  if (!event.metaKey) return () => {}
  const token = crypto.randomUUID()
  const unsubscribe = window.api.onTldrHoldReleased(released => { if (released === token) release() })
  window.api.startTldrHold(event.code, token)
  return () => { unsubscribe(); window.api.stopTldrHold(token) }
}

/** Resolve the chord through the normal binding table before calling start.
 * Remember the physical key and modifiers that actually began this hold, not
 * Cmd+L literals: rebinding in Settings must change both press AND release. */
export function createTldrHoldController(
  setHeld = (held: boolean, preview: PreviewKind = 'tldr') =>
    useTldrView.setState(held ? { held, latched: false, preview } : { held, latched: false }),
  observeRelease: (event: HoldEvent, release: () => void) => () => void = () => () => {},
) {
  let gesture: HoldEvent | null = null
  let stopObserving: (() => void) | null = null
  const release = () => {
    if (!gesture) return
    gesture = null
    stopObserving?.()
    stopObserving = null
    setHeld(false)
  }
  return {
    start(event: HoldEvent, preview: PreviewKind = 'tldr') {
      if (event.repeat || gesture) return
      gesture = { code: event.code, metaKey: event.metaKey, ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey, repeat: false }
      setHeld(true, preview)
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
