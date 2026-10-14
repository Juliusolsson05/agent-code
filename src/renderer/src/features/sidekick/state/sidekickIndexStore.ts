import { create } from 'zustand'

import type { SidekickIndexView, SidekickSummary } from '@shared/sidekicks/types'

// The renderer's mirror of main's Sidekick index (#1493).
//
// Standalone and NOT persisted — the provider-enablement store's shape: main
// owns the value (workspace.json `sidekicks`, SidekickService), so a renderer
// copy that persisted would be a second truth to drift. Every window holds
// the same view, which is what lets one window's picker say "in another
// window" about a sidekick it does not hold.

type SidekickIndexState = {
  view: SidekickIndexView | null
  /** Accept a view only if it is at least as new as the one held. WHY:
   *  `listSidekicks()` on mount and the `sidekick:changed` broadcast race,
   *  and the reply to an older request can arrive after a newer broadcast. */
  accept: (view: SidekickIndexView) => void
}

export const useSidekickIndexStore = create<SidekickIndexState>(set => ({
  view: null,
  accept: view => set(state => (state.view && state.view.revision > view.revision ? state : { view })),
}))

const EMPTY: SidekickSummary[] = []

export function useSidekickSummaries(): SidekickSummary[] {
  return useSidekickIndexStore(state => state.view?.sidekicks ?? EMPTY)
}

export function useSidekickSummary(id: string | null): SidekickSummary | null {
  return useSidekickIndexStore(state => (id ? state.view?.sidekicks.find(entry => entry.id === id) ?? null : null))
}

export function sidekickHomeDir(): string | null {
  return useSidekickIndexStore.getState().view?.homeDir ?? null
}
