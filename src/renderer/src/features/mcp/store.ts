import { useEffect } from 'react'
import { create } from 'zustand'

import type { UserMcpMutationResult, UserMcpSnapshot } from '@shared/userMcp/types'

type UserMcpState = {
  snapshot: UserMcpSnapshot | null
  setSnapshot: (snapshot: UserMcpSnapshot) => void
}

// Standalone, non-persisted mirror of main's user MCP document (#1143) — the
// provider-enablement shape exactly. Main owns the servers and the secrets; a
// persisted copy here would be a second truth that could drift, and it could
// never hold the secrets anyway.
export const useUserMcpStore = create<UserMcpState>(set => ({
  snapshot: null,
  setSnapshot: snapshot => set({ snapshot }),
}))

export function useUserMcpSnapshot(): UserMcpSnapshot | null {
  return useUserMcpStore(state => state.snapshot)
}

/** Non-render read for commands and pickers. */
export function userMcpSnapshot(): UserMcpSnapshot | null {
  return useUserMcpStore.getState().snapshot
}

/**
 * Apply a mutation result immediately. The same snapshot also arrives on the
 * broadcast; applying it here keeps a switch from flickering back for one IPC
 * hop. Returns the error message for a failed mutation so callers can show it.
 */
export function applyUserMcpResult(result: UserMcpMutationResult): string | null {
  if (result.ok) {
    useUserMcpStore.getState().setSnapshot(result.snapshot)
    return null
  }
  return result.error
}

/** Initial fetch + push subscription. Mount ONCE at the app root, next to
 * useProviderEnablementSync, for the same reason: a second mount would leak
 * IPC listeners and double every change. */
export function useUserMcpSync(): void {
  useEffect(() => {
    let cancelled = false
    void window.api.userMcpGet().then(snapshot => {
      if (!cancelled) useUserMcpStore.getState().setSnapshot(snapshot)
    }).catch(() => {})
    const unsub = window.api.onUserMcpChanged(snapshot => {
      useUserMcpStore.getState().setSnapshot(snapshot)
    })
    return () => {
      cancelled = true
      unsub()
    }
  }, [])
}
