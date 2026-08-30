import { useEffect, useRef } from 'react'

import { appendFeedDebugLog } from '@renderer/session-runtime/feedDebug'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import type { SessionId } from '@renderer/workspace/types'
import {
  isCodexTranscriptObservationEventName,
  pickCodexTranscriptObservationCorrelationIds,
  pickCodexTranscriptObservationData,
  type CodexTranscriptObservationEventName,
  type SessionLifecycleCorrelationIds,
  type SessionLifecycleData,
} from '@shared/lifecycle/events'

import { reportLifecycle } from './report'

const OUTBOX_KIND = 'codex_transcript_observation'

type PendingCodexTranscriptObservation = {
  schemaVersion: 1
  name: CodexTranscriptObservationEventName
  correlationIds?: SessionLifecycleCorrelationIds
  data?: SessionLifecycleData
}

/**
 * Name the observation candidate from the submission that created it.
 *
 * WHY this does not reuse the product entry UUID: optimistic Codex rows still
 * use a millisecond timestamp for historical renderer compatibility, and two
 * submissions can be created in the same millisecond. That key is adequate for
 * today's product behavior but is not an identity we may use to join forensic
 * evidence. The composer already mints a UUID per submission, so this
 * observation-only namespace is unique without changing the rendered entry.
 */
export function codexOptimisticRenderCandidateId(submissionId: string): string {
  return `optimistic-submission:${submissionId}`
}

/**
 * Append one transcript-continuity fact to the existing committed feed-debug
 * log, then let `useCodexTranscriptObservationOutbox` mirror it after React has
 * committed the runtime transition.
 *
 * WHY this indirection exists: React is allowed to evaluate a state updater and
 * abandon it. Calling IPC from inside that updater recorded transitions which
 * never became state, and the exact-once guard could then suppress the later
 * updater React actually committed. Feed-debug is already the renderer's
 * bounded, per-session transition log, so it is the narrowest commit artifact
 * available; using it avoids inventing a second runtime store for diagnostics.
 *
 * The run id is captured NOW rather than read by the later effect. A process
 * exit and replacement `session:started` may be batched into one render. Reading
 * only the final runtime there would falsely attribute the retired process's
 * release/reconcile event to its successor.
 */
export function appendCodexTranscriptObservation(
  current: SessionRuntime,
  name: CodexTranscriptObservationEventName,
  data?: SessionLifecycleData,
  correlationIds?: SessionLifecycleCorrelationIds,
): SessionRuntime {
  const safeData = pickCodexTranscriptObservationData(name, data)
  // An explicitly-present undefined means the producer captured "no run".
  // That is distinct from omitting the key and asking this helper to capture
  // the updater's current run. The distinction prevents an Enter from run A's
  // no-run/startup window being restamped as replacement run B when React
  // evaluates the updater later.
  const hasCapturedRun = correlationIds !== undefined &&
    Object.prototype.hasOwnProperty.call(correlationIds, 'sessionRunId')
  const observationRunId = hasCapturedRun
    ? correlationIds?.sessionRunId
    : current.sessionRunId
  const safeCorrelationIds = pickCodexTranscriptObservationCorrelationIds(name, {
    ...correlationIds,
    ...(observationRunId ? { sessionRunId: observationRunId } : {}),
  }, safeData)
  const observation: PendingCodexTranscriptObservation = {
    schemaVersion: 1,
    name,
    ...(safeCorrelationIds ? { correlationIds: safeCorrelationIds } : {}),
    ...(safeData ? { data: safeData } : {}),
  }
  return appendFeedDebugLog(current, {
    layer: 'STATE',
    kind: OUTBOX_KIND,
    summary: `codex transcript observation · ${name}`,
    data: observation,
  })
}

function readPendingObservation(value: unknown): PendingCodexTranscriptObservation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  if (input.schemaVersion !== 1 || !isCodexTranscriptObservationEventName(input.name)) {
    return null
  }
  const data = pickCodexTranscriptObservationData(input.name, input.data)
  const correlationIds = pickCodexTranscriptObservationCorrelationIds(
    input.name,
    input.correlationIds,
    data,
  )
  return {
    schemaVersion: 1,
    name: input.name,
    ...(correlationIds ? { correlationIds } : {}),
    ...(data ? { data } : {}),
  }
}

type ObservationCursor = {
  epochMs: number | null
  entryId: number
}

function firstEntryAfter(
  entries: SessionRuntime['feedDebugLog'],
  cursorId: number,
): number {
  let low = 0
  let high = entries.length
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2)
    if ((entries[middle]?.id ?? Number.POSITIVE_INFINITY) <= cursorId) {
      low = middle + 1
    } else {
      high = middle
    }
  }
  return low
}

/**
 * Mirror committed outbox rows to main's always-on lifecycle journal.
 *
 * This hook observes only runtime state React has already committed. Its cursor
 * is delivery bookkeeping, not product state: losing it can duplicate a debug
 * fact after a workspace-hook remount, but can never add/remove a prompt or
 * influence reconciliation. Advancing across every feed-debug row prevents a
 * busy semantic stream from making us repeatedly rescan unrelated entries.
 */
export function useCodexTranscriptObservationOutbox(
  runtimes: Record<SessionId, SessionRuntime>,
): void {
  const cursorsRef = useRef(new Map<SessionId, ObservationCursor>())

  useEffect(() => {
    const liveSessionIds = new Set(Object.keys(runtimes))
    for (const sessionId of cursorsRef.current.keys()) {
      if (!liveSessionIds.has(sessionId)) cursorsRef.current.delete(sessionId)
    }

    for (const [sessionId, runtime] of Object.entries(runtimes)) {
      const previous = cursorsRef.current.get(sessionId)
      const epochChanged = previous?.epochMs !== runtime.feedDebugEpochMs
      let entryId = epochChanged ? 0 : (previous?.entryId ?? 0)

      // `runtimes` changes for every screen/semantic tick across the workspace.
      // Most sessions did not append a feed-debug row on that tick. Without
      // this tail check, one active agent made the effect rescan 500 rows for
      // every other restored agent—roughly 50k comparisons per event in a
      // 100-pane workspace. Same epoch + an already-consumed tail is a complete
      // O(1) proof that this session has no pending observation.
      const lastEntry = runtime.feedDebugLog[runtime.feedDebugLog.length - 1]
      if (!epochChanged && (!lastEntry || lastEntry.id <= entryId)) continue

      const firstEntry = runtime.feedDebugLog[0]
      const expectedFirstEntryId = epochChanged ? 1 : entryId + 1
      if (firstEntry && firstEntry.id > expectedFirstEntryId) {
        // The shared feed-debug ring evicted rows before this commit effect could
        // inspect them. We cannot know whether every missing row was unrelated
        // debug noise, so the only truthful statement is that the Stage 0
        // projection MAY be incomplete. Keep the gap pane-scoped: attaching the
        // runtime's current run would falsely assign rows that may belong to the
        // predecessor process batched into the same React commit.
        reportLifecycle('transcript.outbox-gap', sessionId, {
          missedFeedRows: firstEntry.id - expectedFirstEntryId,
        })
      }

      // IDs are monotonic within one feed-debug epoch. Binary-searching the
      // suffix keeps an active session at O(log cap + new rows), instead of
      // replaying the whole 500-row ring on every semantic delta.
      const start = epochChanged ? 0 : firstEntryAfter(runtime.feedDebugLog, entryId)
      for (let index = start; index < runtime.feedDebugLog.length; index += 1) {
        const entry = runtime.feedDebugLog[index]!
        entryId = entry.id
        if (entry.kind !== OUTBOX_KIND) continue
        const observation = readPendingObservation(entry.data)
        if (!observation) continue
        reportLifecycle(
          observation.name,
          sessionId,
          observation.data,
          observation.correlationIds,
        )
      }

      cursorsRef.current.set(sessionId, {
        epochMs: runtime.feedDebugEpochMs,
        entryId,
      })
    }
  }, [runtimes])
}
