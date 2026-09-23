import { create } from 'zustand'

// Spotlight's Split | Browser segmented control (spec §4.3). "Agent" (pocket
// hidden) is the pocket's own `view: 'collapsed'`, so it persists; "Browser"
// (pocket fills Spotlight, agent stays mounted but hidden) is a momentary viewing
// choice and deliberately NOT persisted — coming back to Spotlight later should
// show both halves again.
type Store = { browserOnly: boolean; set: (browserOnly: boolean) => void }

export const useSpotlightPocketMode = create<Store>(set => ({
  browserOnly: false,
  set: browserOnly => set({ browserOnly }),
}))
