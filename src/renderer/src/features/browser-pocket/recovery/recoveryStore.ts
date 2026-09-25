import { create } from 'zustand'

export type RecoveryStatus =
  | { kind: 'sending' }
  | { kind: 'sent' | 'queued' }
  | { kind: 'refused'; message: string; retryable: boolean }
  | { kind: 'uncertain' }

export type RecoveryRequest = { token: string; url: string; status: RecoveryStatus }

/** Receipt state belongs to the pocket, not a mounted overlay or guest. A
 * guest remount or Spotlight transition can hide the overlay; neither is a
 * new instruction to the agent. Tokens also fence late async completions:
 * clearing a pocket must not let a resolved IPC promise recreate its state.
 * This is per-window admission, not durable exactly-once task execution. */
export const useRecoveryStore = create<{
  requests: Record<string, RecoveryRequest>
  begin: (pocketId: string, url: string) => string | null
  finish: (pocketId: string, token: string, status: RecoveryStatus) => void
  clear: (pocketId: string, token?: string) => void
  navigating: (pocketId: string, url: string) => void
}>(set => ({
  requests: {},
  begin: (pocketId, url) => {
    let token: string | null = null
    set(s => {
      const prev = s.requests[pocketId]
      if (prev && !(prev.status.kind === 'refused' && prev.status.retryable)) return s
      token = crypto.randomUUID()
      return { requests: { ...s.requests, [pocketId]: { token, url, status: { kind: 'sending' } } } }
    })
    return token
  },
  finish: (pocketId, token, status) => set(s => {
    const current = s.requests[pocketId]
    if (current?.token !== token) return s
    return { requests: { ...s.requests, [pocketId]: { ...current, status } } }
  }),
  clear: (pocketId, token) => set(s => {
    if (!s.requests[pocketId] || (token && s.requests[pocketId]?.token !== token)) return s
    const { [pocketId]: _removed, ...requests } = s.requests
    return { requests }
  }),
  navigating: (pocketId, url) => set(s => {
    const request = s.requests[pocketId]
    if (!request || request.url === url) return s
    const { [pocketId]: _removed, ...requests } = s.requests
    return { requests }
  }),
}))
