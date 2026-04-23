import { useEffect } from 'react'

import type { SessionId } from '@renderer/workspace/types'
import type { SessionRuntime } from '@renderer/workspace/workspaceState'

import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'

// Ship runtime feed-debug entries to the main process on every
// runtime update. The main-side queue writes them to
// <userData>/feed-debug/<sessionId>.jsonl.
//
// The `persistedFeedDebugIdRef` tracks the largest feed-debug entry
// id we've shipped per session so we don't re-ship entries already
// on disk.

export function useFeedDebugPersist(
  runtimes: Record<SessionId, SessionRuntime>,
  refs: WorkspaceRefs,
): void {
  useEffect(() => {
    for (const [sessionId, runtime] of Object.entries(runtimes)) {
      if (runtime.feedDebugLog.length === 0) continue
      const lastPersistedId = refs.persistedFeedDebugIdRef.current[sessionId] ?? 0
      const pending = runtime.feedDebugLog.filter(entry => entry.id > lastPersistedId)
      if (pending.length === 0) continue
      refs.persistedFeedDebugIdRef.current[sessionId] =
        pending[pending.length - 1]?.id ?? lastPersistedId
      void window.api
        .appendFeedDebugLog({
          sessionId,
          entries: pending.map(entry => ({
            id: entry.id,
            ts: entry.ts,
            tMs: entry.tMs,
            layer: entry.layer,
            kind: entry.kind,
            summary: entry.summary,
            data: entry.data,
          })),
        })
        .catch(err => {
          // eslint-disable-next-line no-console
          console.warn(`[feed-debug ${sessionId.slice(0, 8)}] append failed`, err)
        })
    }
  }, [refs.persistedFeedDebugIdRef, runtimes])
}
