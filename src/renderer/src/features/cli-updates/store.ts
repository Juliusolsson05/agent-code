import { useEffect } from 'react'
import { create } from 'zustand'

import type { CliUpdateBehavior, CliUpdateSnapshot } from '@shared/types/cliUpdate.js'
import { DEFAULT_CLI_UPDATE_SNAPSHOT } from '@shared/types/cliUpdate.js'

// Zustand slice mirroring the main-process CliUpdateOrchestrator snapshot.
//
// Kept as its own store rather than folded into `useAppStore` because
// this state is not persisted (main owns it via setup.json), and the
// snapshot object is replaced wholesale on every transition — no
// partial updates, no merge semantics to worry about. A separate store
// also means the settings row and the banner subscribe independently
// without pulling in the full app-state graph.

type CliUpdateStore = {
  snapshot: CliUpdateSnapshot
  setSnapshot: (next: CliUpdateSnapshot) => void
}

export const useCliUpdateStore = create<CliUpdateStore>((set) => ({
  snapshot: DEFAULT_CLI_UPDATE_SNAPSHOT,
  setSnapshot: (snapshot) => set({ snapshot }),
}))

/** Root-mount hook: fetches the initial snapshot from main and subscribes
 *  to further pushes. Called exactly once from the app root — installing
 *  multiple subscriptions would leak IPC listeners and produce duplicate
 *  banner transitions on every state change.
 *
 *  WHY the initial fetch is separate from the subscription:
 *   The renderer mounts somewhere between boot and the first orchestrator
 *   probe finishing. If we relied purely on the push channel, the banner
 *   would render an empty snapshot until the first transition arrived. A
 *   one-shot `cliUpdatesGet()` on mount fills the store immediately, and
 *   the subscription catches every subsequent change. */
export function useCliUpdateSync(): void {
  useEffect(() => {
    let cancelled = false
    void window.api.cliUpdatesGet().then((snapshot) => {
      if (cancelled) return
      useCliUpdateStore.getState().setSnapshot(snapshot)
    })
    const unsub = window.api.onCliUpdatesState((snapshot) => {
      useCliUpdateStore.getState().setSnapshot(snapshot)
    })
    return () => {
      cancelled = true
      unsub()
    }
  }, [])
}

/** Change the CLI-update behavior. Fire-and-forget; the returned snapshot
 *  from main flows back through the state channel. Exposed as a plain
 *  function (not a hook) so the settings-row callback can call it
 *  without threading a hook through several component layers. */
export function setCliUpdateBehavior(behavior: CliUpdateBehavior): void {
  void window.api.cliUpdatesSetBehavior(behavior).then((snapshot) => {
    useCliUpdateStore.getState().setSnapshot(snapshot)
  })
}
