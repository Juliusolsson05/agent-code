import { subscribe } from './ipc.js'
import type { Unsub } from './types.js'

// Window-chrome coordination.
//
// Currently: the macOS traffic-light (close/minimize/zoom) right-edge
// inset pushed from main as a CSS custom property so the tab bar can
// pad itself without magic pixel values. Zoom-safe, scale-safe.
//
// If we ever add more window-chrome concerns (fullscreen transitions,
// vibrancy recomputation), they cluster here.

export const systemApi = {
  onTrafficLightInset: (cb: (insetPx: number) => void): Unsub =>
    subscribe('traffic-light-inset', cb),
}
