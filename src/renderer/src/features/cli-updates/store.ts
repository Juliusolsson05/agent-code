import { useEffect } from 'react'
import { create } from 'zustand'

import type {
  CliUpdateBehavior,
  CliUpdateKind,
  CliUpdateSnapshot,
  CliUpdateState,
} from '@shared/types/cliUpdate.js'
import { DEFAULT_CLI_UPDATE_SNAPSHOT } from '@shared/types/cliUpdate.js'

// Zustand slice mirroring the main-process CliUpdateOrchestrator snapshot.
//
// Kept as its own store rather than folded into `useAppStore` because
// this state is not persisted (main owns it via setup.json), and the
// snapshot object is replaced wholesale on every transition — no
// partial updates, no merge semantics to worry about. A separate store
// also means the settings row and the banner subscribe independently
// without pulling in the full app-state graph.
//
// Dismiss set intentionally lives in renderer memory only:
//   - "I don't want to see THIS banner right now" is a session-scoped
//     wish. A dismiss that survived app restarts would silently mute
//     future launches' banners for the same version, which is the
//     Cursor complaint pattern we specifically want to avoid.
//   - Identity-keyed (see dismissKey below): as soon as the underlying
//     state's identity changes (new latest version, transition to a
//     different kind), the dismiss key changes and the banner reappears.
//     No manual un-dismiss needed.
//   - No IPC round-trip: the orchestrator doesn't need to know what the
//     user is currently ignoring; state pushes stay authoritative and
//     the renderer decides what to paint.

type CliUpdateStore = {
  snapshot: CliUpdateSnapshot
  dismissed: Set<string>
  setSnapshot: (next: CliUpdateSnapshot) => void
  dismiss: (key: string) => void
}

export const useCliUpdateStore = create<CliUpdateStore>((set) => ({
  snapshot: DEFAULT_CLI_UPDATE_SNAPSHOT,
  dismissed: new Set<string>(),
  setSnapshot: (snapshot) => set({ snapshot }),
  dismiss: (key) =>
    set(state => {
      // Wrap in a NEW Set so components that subscribe via
      // `useCliUpdateStore(state => state.dismissed)` re-render — mutating
      // in place would leave subscribers holding the previous reference.
      const next = new Set(state.dismissed)
      next.add(key)
      return { dismissed: next }
    }),
}))

/** Identity key for a CLI update banner state. Same (kind, identity)
 *  produces the same key so a re-emit of the same state doesn't
 *  resurrect a dismissed banner. Identity is drawn from the field that
 *  represents "what this banner is telling the user about" — the target
 *  version for notify/updating/failed/deferred, the delivered version
 *  for updated. Idle / up-to-date states never render a banner so
 *  their key is a stable string that will never appear.
 *
 *  WHY not use a hash of the full state object:
 *   Different snapshots for the SAME "please update Codex 0.140 → 0.144"
 *   situation carry different timestamps (`checkedAt`, `startedAt`).
 *   Hashing the whole thing would produce a new key every probe, which
 *   would defeat the dismissal — the user X's the banner, the next
 *   background probe emits a fresh state with a new timestamp, banner
 *   reappears. The identity key strips the noise and keys on intent. */
export function dismissKey(cli: CliUpdateKind, state: CliUpdateState): string {
  switch (state.kind) {
    case 'notify':
      return `${cli}:notify:${state.latest}`
    case 'updating':
      return `${cli}:updating:${state.to}`
    case 'updated':
      return `${cli}:updated:${state.to}`
    case 'failed':
      return `${cli}:failed:${state.wantedLatest}`
    case 'deferred':
      return `${cli}:deferred:${state.wantedLatest}`
    case 'idle':
    case 'up-to-date':
    default:
      return `${cli}:silent`
  }
}

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
