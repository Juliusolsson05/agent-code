import { create } from 'zustand'

import type { PocketDrivingEvent } from '@shared/browserPocket/types'

// Live page state per pocket, as reported by its guest. Renderer-only and
// keyed by pocketId: none of this survives a restart and none of it may be
// written into SessionMeta (that would autosave on every page load).
export type PocketLive = {
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** Last main-frame load failure, cleared by the next successful navigation. */
  failed: { code: string; description: string; url: string } | null
  /** Crash timestamps for the back-off in placement/lifecycle.ts. */
  crashes: number[]
  /** Remounts the <webview> after a crash (or a profile switch). */
  generation: number
  /** Crashed too often in 30 s; waiting for the user to press Reload. */
  crashedOut: boolean
  /** Slept by the sleep policy; recreated on next visibility. */
  asleep: boolean
  driving: PocketDrivingEvent['state']
  drivingAction: string | null
  drivingPoint: { x: number; y: number } | null
  drivingAt: number
  thumbnail: string | null
  /** Console errors since the user last looked at the pocket. */
  unseenErrors: number
  /** Increments each time the address bar should take focus. */
  focusAddressTick: number
  picking: boolean
}

const EMPTY: PocketLive = {
  title: '', loading: false, canGoBack: false, canGoForward: false, failed: null,
  crashes: [], generation: 0, crashedOut: false, asleep: false,
  driving: null, drivingAction: null, drivingPoint: null, drivingAt: 0,
  thumbnail: null, unseenErrors: 0, focusAddressTick: 0, picking: false,
}

type Store = {
  live: Record<string, PocketLive>
  patch: (pocketId: string, patch: Partial<PocketLive> | ((prev: PocketLive) => Partial<PocketLive>)) => void
  forget: (pocketId: string) => void
}

export const usePocketLiveStore = create<Store>(set => ({
  live: {},
  patch: (pocketId, patch) => set(s => {
    const prev = s.live[pocketId] ?? EMPTY
    const delta = typeof patch === 'function' ? patch(prev) : patch
    let changed = false
    for (const key of Object.keys(delta) as Array<keyof PocketLive>) if (prev[key] !== delta[key]) { changed = true; break }
    if (!changed && s.live[pocketId]) return s
    return { live: { ...s.live, [pocketId]: { ...prev, ...delta } } }
  }),
  forget: pocketId => set(s => {
    if (!s.live[pocketId]) return s
    const { [pocketId]: _gone, ...live } = s.live
    return { live }
  }),
}))

export function usePocketLive(pocketId: string | undefined): PocketLive {
  return usePocketLiveStore(s => (pocketId ? s.live[pocketId] : undefined) ?? EMPTY)
}
