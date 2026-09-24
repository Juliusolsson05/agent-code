import { create } from 'zustand'

import type { LanePort } from '@shared/browserPocket/types'

// Dev-server ports per agent session, pushed by main's LanePortWatcher. Keyed
// by SessionId (the watcher is told which sessions to watch); a remapped
// session simply gets its ports on the next scan.
type Store = {
  bySession: Record<string, LanePort[]>
  replace: (bySession: Record<string, LanePort[]>) => void
}

const EMPTY: LanePort[] = []

export const useLanePortsStore = create<Store>(set => ({
  bySession: {},
  replace: bySession => set(s => (sameMap(s.bySession, bySession) ? s : { bySession })),
}))

export function useLanePorts(sessionId: string | null | undefined): LanePort[] {
  return useLanePortsStore(s => (sessionId ? s.bySession[sessionId] : undefined) ?? EMPTY)
}

// The watcher re-broadcasts every scan; unchanged results must not re-render
// every lane header.
function sameMap(a: Record<string, LanePort[]>, b: Record<string, LanePort[]>): boolean {
  const ak = Object.keys(a)
  if (ak.length !== Object.keys(b).length) return false
  return ak.every(k => {
    const x = a[k]!
    const y = b[k]
    return y !== undefined && x.length === y.length && x.every((p, i) => p.port === y[i]!.port && p.pid === y[i]!.pid && p.kind === y[i]!.kind)
  })
}
