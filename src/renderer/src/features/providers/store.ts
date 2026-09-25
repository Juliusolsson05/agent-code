import { create } from 'zustand'
import { useEffect } from 'react'

import type { ProviderEnablementSnapshot } from '@shared/types/providerEnablement'
import { AGENT_PROVIDER_KINDS, type AgentProviderKind } from '@shared/types/providerKind'

// The derived enabled-set is stored BESIDE the snapshot rather than computed
// in a selector: useSyncExternalStore identity-compares selector results, so
// a `new Set(...)` per call would return a fresh object every render and
// loop the component. One derivation per snapshot keeps the reference — and
// therefore every picker subscribed to it — stable.
const FAIL_OPEN_KINDS: ReadonlySet<AgentProviderKind> = new Set(AGENT_PROVIDER_KINDS)

function deriveEnabledKinds(
  snapshot: ProviderEnablementSnapshot | null,
): ReadonlySet<AgentProviderKind> {
  if (!snapshot) return FAIL_OPEN_KINDS
  return new Set(snapshot.entries.filter(entry => entry.enabled).map(entry => entry.kind))
}

type ProviderEnablementState = {
  snapshot: ProviderEnablementSnapshot | null
  enabledKinds: ReadonlySet<AgentProviderKind>
  setSnapshot: (snapshot: ProviderEnablementSnapshot) => void
}

// Standalone, non-persisted zustand store — the cli-updates shape exactly:
// main owns the value (setup.json), the store is just the renderer's mirror,
// so persisting it here would only create a second truth to drift (#1102).
export const useProviderEnablementStore = create<ProviderEnablementState>(set => ({
  snapshot: null,
  enabledKinds: FAIL_OPEN_KINDS,
  setSnapshot: snapshot => set({ snapshot, enabledKinds: deriveEnabledKinds(snapshot) }),
}))

/** Fail-open before the first snapshot: matches pre-#1102 behavior and never
 * hides a provider because a poll had not landed. Computes at call time —
 * this is the non-render path, so a fresh Set carries no re-render cost. */
export function enabledAgentProviderKindsSnapshot(): ReadonlySet<AgentProviderKind> {
  return deriveEnabledKinds(useProviderEnablementStore.getState().snapshot)
}

export function useEnabledAgentProviderKinds(): ReadonlySet<AgentProviderKind> {
  return useProviderEnablementStore(state => state.enabledKinds)
}

export function useProviderEnablementSnapshot(): ProviderEnablementSnapshot | null {
  return useProviderEnablementStore(state => state.snapshot)
}

/** Initial fetch + push subscription. Mount ONCE at the app root (App.tsx),
 * next to useCliUpdateSync — the same mount-once discipline, for the same
 * reason: a second mount would leak IPC listeners and double every change. */
export function useProviderEnablementSync(): void {
  useEffect(() => {
    let cancelled = false
    void window.api.providerEnablementGet().then(snapshot => {
      if (!cancelled) useProviderEnablementStore.getState().setSnapshot(snapshot)
    })
    const unsub = window.api.onProviderEnablementChanged(snapshot => {
      useProviderEnablementStore.getState().setSnapshot(snapshot)
    })
    return () => {
      cancelled = true
      unsub()
    }
  }, [])
}
