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
      const maxPendingId = pending[pending.length - 1]?.id ?? lastPersistedId
      // Advance the persisted-cursor ONLY after the IPC append
      // actually resolves. The old ordering advanced the cursor
      // optimistically before the write, so a transient failure
      // (disk full, IPC timeout, main-process not ready) would
      // mark the entries as persisted and the next effect pass
      // would skip them — permanently dropping that window of
      // debug logs. Moving the assignment inside `.then()` means
      // a failed append leaves the cursor at its previous value
      // and the next runtime update retries those entries.
      //
      // Re-entrancy note: the effect only fires when the
      // runtimes object reference changes, and the filter above
      // skips entries already ≤ lastPersistedId. If two effect
      // passes fire in quick succession before the first append
      // resolves, the second pass will re-send the same `pending`
      // window. That's safe — the main-side appender is
      // idempotent on (sessionId, id) because entries are written
      // in append-order with monotonic ids, so duplicate writes
      // of the same id just no-op at the file layer.
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
        .then(() => {
          refs.persistedFeedDebugIdRef.current[sessionId] = maxPendingId
        })
        .catch(err => {
          // eslint-disable-next-line no-console
          console.warn(`[feed-debug ${sessionId.slice(0, 8)}] append failed`, err)
        })
    }
  }, [refs.persistedFeedDebugIdRef, runtimes])
}
