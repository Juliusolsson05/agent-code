import { useLayoutEffect, useRef } from 'react'

import type {
  CodexTranscriptObservationOutboxEntry,
  PendingCodexTranscriptObservation,
  SessionRuntime,
} from '@renderer/session-runtime/state'
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

const CODEX_TRANSCRIPT_OBSERVATION_OUTBOX_CAP = 500
let lastObservationEpochMs = Date.now()

function nextObservationEpochMs(): number {
  // WHY not use Date.now() alone: replacing a runtime inside the same
  // millisecond can reset ids to one while a hook cursor still points at the
  // retired ring. A process-local monotonic epoch makes that reset visible
  // without persisting or exporting another identifier.
  lastObservationEpochMs = Math.max(Date.now(), lastObservationEpochMs + 1)
  return lastObservationEpochMs
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
 * Append one transcript-continuity fact to a bounded runtime sidecar, then let
 * `useCodexTranscriptObservationOutbox` mirror it after React has committed the
 * runtime transition.
 *
 * WHY this indirection exists: React is allowed to evaluate a state updater and
 * abandon it. Calling IPC from inside that updater recorded transitions which
 * never became state, and the exact-once guard could then suppress the later
 * updater React actually committed. The sidecar must be separate from
 * feed-debug: observation volume is not allowed to evict product/feed evidence
 * or make Stage 0 alter the debugging behavior it is meant to observe.
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
  const entry: CodexTranscriptObservationOutboxEntry = {
    id: current.codexTranscriptObservationNextId,
    observation,
  }
  const outbox = current.codexTranscriptObservationOutbox.length >=
      CODEX_TRANSCRIPT_OBSERVATION_OUTBOX_CAP
    ? [
        ...current.codexTranscriptObservationOutbox.slice(
          current.codexTranscriptObservationOutbox.length -
            CODEX_TRANSCRIPT_OBSERVATION_OUTBOX_CAP + 1,
        ),
        entry,
      ]
    : [...current.codexTranscriptObservationOutbox, entry]
  return {
    ...current,
    codexTranscriptObservationOutbox: outbox,
    codexTranscriptObservationNextId: entry.id + 1,
    codexTranscriptObservationEpochMs:
      current.codexTranscriptObservationEpochMs ?? nextObservationEpochMs(),
  }
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
  entries: SessionRuntime['codexTranscriptObservationOutbox'],
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
 * influence reconciliation. Layout timing is deliberate: TileLeaf reports
 * visible surfaces from a passive effect, and React runs child passive effects
 * before parent passive effects. Mirroring committed mutations here first
 * preserves mutation-before-visibility chronology without moving product UI
 * work into the layout phase.
 */
export function useCodexTranscriptObservationOutbox(
  runtimes: Record<SessionId, SessionRuntime>,
): void {
  const cursorsRef = useRef(new Map<SessionId, ObservationCursor>())

  useLayoutEffect(() => {
    const liveSessionIds = new Set(Object.keys(runtimes))
    for (const sessionId of cursorsRef.current.keys()) {
      if (!liveSessionIds.has(sessionId)) cursorsRef.current.delete(sessionId)
    }

    for (const [sessionId, runtime] of Object.entries(runtimes)) {
      const previous = cursorsRef.current.get(sessionId)
      const epochChanged = previous?.epochMs !==
        runtime.codexTranscriptObservationEpochMs
      let entryId = epochChanged ? 0 : (previous?.entryId ?? 0)

      // `runtimes` changes for every screen/semantic tick across the workspace.
      // Most sessions did not append an observation on that tick. Without this
      // tail check, one active agent made the effect rescan 500 rows for
      // every other restored agent—roughly 50k comparisons per event in a
      // 100-pane workspace. Same epoch + an already-consumed tail is a complete
      // O(1) proof that this session has no pending observation.
      const lastEntry = runtime.codexTranscriptObservationOutbox[
        runtime.codexTranscriptObservationOutbox.length - 1
      ]
      if (!epochChanged && (!lastEntry || lastEntry.id <= entryId)) continue

      const firstEntry = runtime.codexTranscriptObservationOutbox[0]
      const expectedFirstEntryId = epochChanged ? 1 : entryId + 1
      if (firstEntry && firstEntry.id > expectedFirstEntryId) {
        // The dedicated ring evicted rows before this commit effect could
        // inspect them, so the Stage 0 projection is definitely incomplete.
        // Keep the gap pane-scoped: attaching the runtime's current run would
        // falsely assign rows that may belong to the predecessor process
        // batched into the same React commit.
        reportLifecycle('transcript.outbox-gap', sessionId, {
          missedObservationRows: firstEntry.id - expectedFirstEntryId,
        })
      }

      // IDs are monotonic within one observation epoch. Binary-searching the
      // suffix keeps an active session at O(log cap + new rows), instead of
      // replaying the whole 500-row ring on every semantic delta.
      const start = epochChanged
        ? 0
        : firstEntryAfter(runtime.codexTranscriptObservationOutbox, entryId)
      for (
        let index = start;
        index < runtime.codexTranscriptObservationOutbox.length;
        index += 1
      ) {
        const entry = runtime.codexTranscriptObservationOutbox[index]!
        entryId = entry.id
        const observation = readPendingObservation(entry.observation)
        if (!observation) continue
        reportLifecycle(
          observation.name,
          sessionId,
          observation.data,
          observation.correlationIds,
        )
      }

      cursorsRef.current.set(sessionId, {
        epochMs: runtime.codexTranscriptObservationEpochMs,
        entryId,
      })
    }
  }, [runtimes])
}
