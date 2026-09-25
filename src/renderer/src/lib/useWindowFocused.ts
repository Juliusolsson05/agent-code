import { useSyncExternalStore } from 'react'

/**
 * Is this app window the one the user is using right now: focused, and not
 * minimised or on another desktop?
 *
 * WHY both signals: `document.hasFocus()` goes false when the user switches to
 * another app, and `visibilityState` goes 'hidden' when the window is
 * minimised or on another Space. Either on its own misses a case. Electron
 * turns off background throttling for this app, so timers keep running in the
 * background at full speed. Without this, a dwell timer counts time the user
 * spent in another app as time spent looking at a pane (PR #1176 review).
 *
 * useSyncExternalStore instead of useState plus an effect: the value is read
 * during render. So the first render after a window switch already sees it,
 * rather than one render later.
 */
export function useWindowFocused(): boolean {
  return useSyncExternalStore(subscribe, read, () => true)
}

function read(): boolean {
  return document.hasFocus() && document.visibilityState === 'visible'
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('focus', onChange)
  window.addEventListener('blur', onChange)
  document.addEventListener('visibilitychange', onChange)
  return () => {
    window.removeEventListener('focus', onChange)
    window.removeEventListener('blur', onChange)
    document.removeEventListener('visibilitychange', onChange)
  }
}
