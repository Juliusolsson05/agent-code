import type {
  SessionRuntime,
  TranscriptStatus,
} from '@renderer/workspace/workspaceState'
import { appendFeedDebugLog } from '@renderer/workspace/runtime/feedDebug'

// #283 diagnostic instrumentation — NOT the fix.
//
// Symptom: on startup (rehydrate) and on resuming a killed session, a pane
// can stay stuck at transcriptStatus 'loading' forever; a manual reload
// unsticks it. The on-paper analysis in the issue could not pin the exact
// interleaving, because two write paths can each silently drop an in-flight
// load's terminal status write:
//
//   1. loadInitialHistoryForSession (initialHistory.ts) writes 'loading'
//      UNCONDITIONALLY (prev[id] ?? emptyRuntime()), but writes the terminal
//      'ready'/'error' only inside `if (!current) return prev`. If the
//      session's runtime entry is dropped or re-keyed (idMap remap) while the
//      load awaits IPC, the terminal write hits a missing key and is thrown
//      away — leaving the surviving runtime parked at 'loading'.
//
//   2. commitRehydratedState (rehydrate.ts) rebuilds the whole runtimes map
//      from a fresh `out = {}` and forces any status that isn't already
//      'ready'/'error' back to 'loading' for sessions that have a
//      providerSessionId. If that fires for a session whose loader already
//      resolved-and-was-dropped (or never gets re-driven), the pane is parked
//      at 'loading' with no loader running — exactly "stuck until manual
//      reload", since reload re-invokes the loader under the stable id.
//
// This module makes those two paths observable in the timeline the issue
// reporter already reads (per-session feed-debug.jsonl). It reuses the
// existing feed-debug logger rather than inventing a parallel channel
// (consistent with #102's "one debug home"). Once a stuck session is
// captured, read the `transcript_status` series + the `[transcript-stuck]`
// console warnings to see which path dropped the write, then fix at source
// and delete this instrumentation.

export type TranscriptStatusSite =
  | 'initial-history:no-provider-id'
  | 'initial-history:loading'
  | 'initial-history:ready'
  | 'initial-history:error'
  | 'rehydrate:rebuild-remapped'
  | 'rehydrate:rebuild-fresh'

/**
 * Record a transcriptStatus transition as a STATE feed-debug entry on the
 * runtime that is about to carry the new status. Returns a NEW runtime ref
 * (the appended log entry); callers should thread this through the same
 * setRuntimes updater that applies the status change so the log and the
 * status land atomically.
 *
 * `from` is read off the runtime as-passed, so call this BEFORE patching
 * transcriptStatus on `current`.
 */
export function traceTranscriptStatus(
  current: SessionRuntime,
  to: TranscriptStatus,
  site: TranscriptStatusSite,
  extra?: Record<string, unknown>,
): SessionRuntime {
  const from = current.transcriptStatus
  return appendFeedDebugLog(current, {
    layer: 'STATE',
    kind: 'transcript_status',
    summary: `transcript ${from} -> ${to} @ ${site}`,
    data: { from, to, site, ...extra },
  })
}

/**
 * Flag the moment a terminal transcript write is discarded because its target
 * runtime key vanished while the load was in flight (the `!current` bail in
 * loadInitialHistoryForSession). There is no runtime to attach a feed-debug
 * entry to — that absence IS the bug — so this goes to the console with a
 * greppable tag. Seeing this line for a session that is visibly stuck at
 * 'loading' confirms path (1) above.
 */
export function warnTranscriptWriteDiscarded(args: {
  sessionId: string
  intended: TranscriptStatus
  site: TranscriptStatusSite
}): void {
  console.warn(
    `[transcript-stuck][283] discarded '${args.intended}' write @ ${args.site}: ` +
      `runtime[${args.sessionId}] is gone — terminal status write thrown away`,
  )
}

/**
 * Flag when a rehydrate rebuild forces an in-flight 'loading' session back to
 * 'loading' from a fresh `out = {}` map (path (2) above). This is not
 * inherently a bug — it is the normal way rehydrate keeps a still-loading pane
 * marked loading — but if a session shows this WITHOUT a later
 * `initial-history:ready` transition, it means a rebuild parked the pane with
 * no loader driving it. Logged to console because the rebuild may run for a
 * session whose runtime is being (re)created this very tick, so there is no
 * stable prior runtime to append to.
 */
export function warnRehydrateForcedLoading(args: {
  sessionId: string
  baseStatus: TranscriptStatus
  hasProviderSessionId: boolean
  site: TranscriptStatusSite
}): void {
  console.warn(
    `[transcript-stuck][283] rehydrate rebuild kept '${args.baseStatus}' as 'loading' ` +
      `@ ${args.site} for runtime[${args.sessionId}] ` +
      `(providerSessionId=${args.hasProviderSessionId}) — ` +
      `confirm a loader later drives it to 'ready'`,
  )
}
