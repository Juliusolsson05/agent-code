import { create } from 'zustand'

// Preview state is deliberately outside persisted Settings/workspace state.
// Restarting the renderer while a key is held must never restore a darkened UI.
export const useTldrView = create<{ held: boolean; latched: boolean }>(() => ({ held: false, latched: false }))
export function dismissTldr(): void { useTldrView.setState({ held: false, latched: false }) }
export function toggleTldr(): void {
  const state = useTldrView.getState()
  useTldrView.setState({ held: false, latched: !(state.held || state.latched) })
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
  setHeld = (held: boolean) => useTldrView.setState({ held, latched: false }),
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
    start(event: HoldEvent) {
      if (event.repeat || gesture) return
      gesture = { code: event.code, metaKey: event.metaKey, ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey, repeat: false }
      setHeld(true)
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
