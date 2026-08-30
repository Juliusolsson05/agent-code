import { ipcMain } from 'electron'

import type { AppRunJournal } from '@main/incident/AppRunJournal.js'
import { SessionLifecycleJournal } from '@main/lifecycle/SessionLifecycleJournal.js'
import type { SessionRecorderManager } from '@main/recording/SessionRecorderManager.js'
import type { SessionManager } from '@main/sessionManager.js'
import {
  isCodexRendererTranscriptObservationEventName,
  isCodexTranscriptObservationEventName,
  isCodexTranscriptObservationSessionId,
  isSessionLifecycleEventName,
  pickCodexTranscriptObservationCorrelationIds,
  pickCodexTranscriptObservationData,
  pickLifecycleData,
  pickLifecycleCorrelationIds,
  type CodexTranscriptObservationEventName,
} from '@shared/lifecycle/events.js'

// These three names existed as provider-neutral lifecycle breadcrumbs before
// Stage 0 selected them for the Codex observation projection. Preserve their
// Claude/OpenCode journal behavior; every other name in the projection is new
// and must fail closed when a shared renderer path reports it for another kind.
const LEGACY_CROSS_PROVIDER_SUBMIT_EVENTS: ReadonlySet<string> = new Set([
  'submit.begin',
  'submit.result',
  'submit.unwound',
])

// Renderer reports may never manufacture these rows. Main owns both edges of
// the gap because only main knows whether the shared token bucket admitted a
// report. Accepting the name back over IPC would let an untrusted renderer
// forge completeness evidence for a gap it cannot observe.
const MAIN_OWNED_OBSERVATION_GAP_EVENT = 'transcript.observation-gap'
const MAX_TRACKED_OBSERVATION_GAP_KEYS = 1024
export type LifecycleIpcDiagnostics = {
  getCodexTranscriptObservationCompletenessSnapshot(): {
    gapTrackingCapped: boolean
  }
}

// Bridges renderer-observed session-lifecycle facts into the always-on journal.
//
// WHY the renderer needs its own channel at all: main sees ownership (who holds
// the backend) but is structurally blind to intent (WHO asked for a wake, and
// whether restore ever finished). The nine wake call sites, rehydrate's
// completion accounting, transcript loading, and composer submit all live in
// the renderer. A boot ladder assembled from main alone cannot answer "why did
// something try to wake this pane", which is the question #596 and #598 both
// turned on.
//
// WHY `send` and not `invoke`: this is fire-and-forget diagnostics. An invoke
// would couple a renderer emit point to main IPC latency, and every emit point
// sits on a hot path (mount effects, submit handlers). Nothing in the renderer
// may ever wait on, or branch on, a lifecycle report.
//
// WHY main re-validates what the renderer already filtered: IPC is a runtime
// trust boundary. `ipc/incident.ts` states the rule this file follows — the
// sender "may itself be misbehaving", and a renderer mid-freeze or mid-crash is
// exactly the sender we most expect to be malformed. Filtering in the renderer
// too is not redundancy for its own sake: it means a mistake surfaces in a
// renderer unit test rather than only as a missing field on someone's disk.

export function registerLifecycleIpc(
  journal: AppRunJournal,
  manager?: Pick<
    SessionManager,
    'getSessionKind' | 'getSessionRunId' | 'getCodexSessionRunState'
  >,
  sessionRecorders?: SessionRecorderManager | null,
): LifecycleIpcDiagnostics {
  const lifecycle = new SessionLifecycleJournal(journal)

  // Token bucket, same shape as the incident channel but sized for a different
  // traffic profile. Lifecycle events are routine rather than crash-adjacent,
  // and one cold boot of a large workspace legitimately emits a burst: ~15
  // visible panes × (recover.request + wake.request + history.load start/end)
  // lands ~60 events inside a second or two.
  //
  // WHY the ceiling exists anyway: a remount loop or a retry storm is precisely
  // the pathological state this instrumentation is meant to observe, and an
  // unbounded channel would let that state flood the journal and evict the
  // breadcrumbs explaining it. Dropping the excess and recording the COUNT
  // keeps the storm visible as one honest fact instead of ten thousand.
  const RATE_PER_SEC = 100
  const BURST = 300
  let tokens = BURST
  let lastRefill = Date.now()
  let suppressed = 0
  type ObservationGap = {
    sessionId: string
    sessionRunId?: string
    dropped: number
    countCapped?: boolean
  }
  const observationGaps = new Map<string, ObservationGap>()
  // An `opened` row deliberately bypasses the exhausted report bucket. A
  // forged retired {sessionId, runId} pair could otherwise turn that exception
  // into an unlimited disk writer by changing identity on every report. This
  // process-lifetime ceiling never refills: after 1024 distinct/reopened gaps,
  // additional loss remains represented by legacy report.suppressed only.
  let observationGapOpenings = 0
  // The opening ceiling is an essential abuse bound, but reaching it means the
  // pane-filtered Stage 0 projection can no longer mark every dropped row. Keep
  // that fact as monotonic main-owned state so manual bundle export can refuse
  // to label the named stream complete even after all earlier gaps closed.
  let observationGapTrackingCapped = false

  const observationGapKey = (
    sessionId: string,
    sessionRunId: string | undefined,
  ): string => JSON.stringify([sessionId, sessionRunId ?? null])

  const recordObservationGap = (params: {
    phase: 'opened' | 'closed'
    gap: ObservationGap
    runDisposition: 'current' | 'stale' | 'missing' | 'retired-or-unknown'
    recorderRunEligible: boolean
  }): void => {
    const rawIds = {
      // Missing is a real, separate attribution bucket. Never substitute the
      // registry's current run here: that is the A→B contamination this gap
      // evidence exists to expose.
      ...(params.gap.sessionRunId ? { sessionRunId: params.gap.sessionRunId } : {}),
    }
    const data = pickCodexTranscriptObservationData(
      MAIN_OWNED_OBSERVATION_GAP_EVENT,
      {
        phase: params.phase,
        runDisposition: params.runDisposition,
        ...(params.phase === 'closed' ? {
          suppressed: params.gap.dropped,
          ...(params.gap.countCapped ? { countCapped: true } : {}),
        } : {}),
      },
    )
    const safeCorrelationIds = pickCodexTranscriptObservationCorrelationIds(
      MAIN_OWNED_OBSERVATION_GAP_EVENT,
      rawIds,
      data,
    )
    const ids = {
      ...(safeCorrelationIds ?? {}),
      // Main, not the renderer correlation bag, owns pane attribution. Keep
      // this outside the event-specific relation picker so a future widening
      // of that shared picker cannot admit a contradictory sessionId.
      sessionId: params.gap.sessionId,
    }
    lifecycle.record(MAIN_OWNED_OBSERVATION_GAP_EVENT, ids, data)
    if (
      params.recorderRunEligible &&
      params.gap.sessionRunId
    ) {
      sessionRecorders?.recordCodexTranscriptObservation(
        params.gap.sessionId,
        params.gap.sessionRunId,
        {
        schemaVersion: 1,
        name: MAIN_OWNED_OBSERVATION_GAP_EVENT,
        ids,
        ...(data ? { data } : {}),
        },
      )
    }
  }

  ipcMain.on('session:lifecycle-report', (_event, report: unknown) => {
    if (!report || typeof report !== 'object') return
    const r = report as Record<string, unknown>
    // An unknown name is dropped rather than passed through. The vocabulary is
    // closed on purpose (see @shared/lifecycle/events) and a renderer from a
    // different build must not be able to widen it at runtime.
    if (!isSessionLifecycleEventName(r.name)) return
    const isTranscriptObservationName = isCodexTranscriptObservationEventName(r.name)
    // Stage 0 contains facts from four authorities. IPC is only the renderer's
    // authority boundary: accepting a provider/main name here would let a
    // compromised renderer forge request, rollout, or completeness evidence
    // with perfectly valid-looking opaque IDs. The gap row is covered here too
    // because main alone knows what its token bucket actually dropped.
    if (
      isTranscriptObservationName &&
      !isCodexRendererTranscriptObservationEventName(r.name)
    ) return
    const sessionId = typeof r.sessionId === 'string' ? r.sessionId.slice(0, 200) : undefined
    const rendererCorrelationIds = pickLifecycleCorrelationIds(r.correlationIds)
    const rendererSessionRunId = rendererCorrelationIds?.sessionRunId
    const registeredSessionRunId = sessionId && manager
      ? manager.getSessionRunId(sessionId) ?? undefined
      : undefined
    const registeredSessionKind = sessionId && manager
      ? manager.getSessionKind(sessionId)
      : undefined
    const legacySubmitEvent = LEGACY_CROSS_PROVIDER_SUBMIT_EVENTS.has(r.name)
    const reportedProvider = r.data && typeof r.data === 'object' && !Array.isArray(r.data)
      ? (r.data as Record<string, unknown>).provider
      : undefined
    const exactCodexRunState = sessionId && rendererSessionRunId && manager
      ? manager.getCodexSessionRunState(sessionId, rendererSessionRunId)
      : null
    const exactCurrentCodexRun = Boolean(
      registeredSessionKind === 'codex' &&
      rendererSessionRunId &&
      rendererSessionRunId === registeredSessionRunId,
    )
    const liveCodexMissingRun = Boolean(
      registeredSessionKind === 'codex' && rendererSessionRunId === undefined,
    )
    const exactRetiredCodexRun = exactCodexRunState === 'retired'
    const liveCodexLegacyRunProvenance = Boolean(
      registeredSessionKind === 'codex' &&
      (rendererSessionRunId === undefined || exactCurrentCodexRun),
    )
    const dedicatedTranscriptObservation = isTranscriptObservationName && !legacySubmitEvent
    const dedicatedObservationAccepted = Boolean(
      dedicatedTranscriptObservation &&
      sessionId &&
      isCodexTranscriptObservationSessionId(sessionId) &&
      (exactCurrentCodexRun || liveCodexMissingRun || exactRetiredCodexRun),
    )
    const isCodexTranscriptObservation = Boolean(
      isTranscriptObservationName &&
      (dedicatedObservationAccepted || (
        legacySubmitEvent &&
        (liveCodexLegacyRunProvenance ||
          (reportedProvider === 'codex' && exactRetiredCodexRun))
      )),
    )

    // submit.begin/result/unwound predate Stage 0 and are intentionally emitted
    // by Claude/OpenCode too, so their generic lifecycle rows survive. Every
    // dedicated row is stricter: a UUID pane plus either the exact current run,
    // a missing-run bucket while Codex is live, or the manager's exact retired
    // pair proof. Legacy rows retain their generic path, but become Codex
    // observations only with the same run proof; a shape-valid unknown run on
    // a live Codex pane is not "stale" merely because its pane happens to exist.
    // Merely finding no live registry entry is not provenance—a forged UUID/run
    // pair must fail closed rather than become Codex evidence.
    if (dedicatedTranscriptObservation && !dedicatedObservationAccepted) return

    // WHY main validates but NEVER replaces a supplied renderer run id:
    // sessionId names a durable pane, not a process. A delayed effect from run A
    // can arrive after run B has reused that pane. Stamping the row with main's
    // *current* run B would manufacture a causal join and make the trace lie.
    // Preserve run A exactly in the app journal, label its relationship to the
    // registry, and refuse to mirror it into run B's active session recording.
    // Missing ids also stay missing—guessing from current registry state has the
    // same replacement race, merely without an explicit contradictory value.
    const runDisposition = isCodexTranscriptObservation && sessionId && manager
      ? rendererSessionRunId === undefined
        ? 'missing'
        : registeredSessionRunId === undefined
          ? 'retired-or-unknown'
          : rendererSessionRunId === registeredSessionRunId
            ? 'current'
            : 'stale'
      : undefined
    const now = Date.now()
    tokens = Math.min(BURST, tokens + ((now - lastRefill) / 1000) * RATE_PER_SEC)
    lastRefill = now
    if (tokens < 1) {
      suppressed += 1
      if (isCodexTranscriptObservation && sessionId) {
        const key = observationGapKey(sessionId, rendererSessionRunId)
        const existing = observationGaps.get(key)
        if (existing) {
          if (existing.dropped < Number.MAX_SAFE_INTEGER) {
            existing.dropped += 1
          } else {
            // The exact count can no longer be represented by the shareable
            // integer schema. Saturate instead of overflowing to an unsafe
            // value that the export sanitizer would drop altogether.
            existing.countCapped = true
          }
        } else {
          if (observationGapOpenings >= MAX_TRACKED_OBSERVATION_GAP_KEYS) {
            // The lifetime ceiling forbids opening another key, but it must not
            // destroy counts for keys already admitted below the memory cap.
            // Evicting first drained the only closable evidence on every later
            // forged pair even though no replacement could be inserted.
            observationGapTrackingCapped = true
            return
          }
          const gap: ObservationGap = {
            sessionId,
            ...(rendererSessionRunId ? { sessionRunId: rendererSessionRunId } : {}),
            dropped: 1,
          }
          observationGaps.set(key, gap)
          observationGapOpenings += 1
          recordObservationGap({
            phase: 'opened',
            gap,
            runDisposition: runDisposition ?? 'retired-or-unknown',
            recorderRunEligible: exactCurrentCodexRun || exactRetiredCodexRun,
          })
        }
      }
      return
    }
    tokens -= 1
    if (suppressed > 0) {
      // Recorded inline, at the point the gap happened, so a reader
      // reconstructing a ladder can tell "this pane emitted nothing" apart from
      // "this pane's events were dropped".
      lifecycle.record('report.suppressed', undefined, { suppressed, reason: 'rate-limited' })
      suppressed = 0
    }

    if (isCodexTranscriptObservation && sessionId && runDisposition) {
      const key = observationGapKey(sessionId, rendererSessionRunId)
      const gap = observationGaps.get(key)
      if (gap) {
        // This is intentionally the last write before the admitted row below.
        // A report for run B looks up B's key and cannot close A; a delayed A
        // report may close A as stale/retired but fails the recorder fence.
        observationGaps.delete(key)
        recordObservationGap({
          phase: 'closed',
          gap,
          runDisposition,
          recorderRunEligible: exactCurrentCodexRun || exactRetiredCodexRun,
        })
      }
    }

    // `pickLifecycleData` inside the emitter drops unallowlisted data keys and
    // non-primitive values. Correlation ids were filtered separately above
    // because they establish joins, and therefore must be rejected whole when
    // malformed rather than truncated into a possibly different identity.
    // Session scope is spread LAST so a future accidental widening of the
    // correlation-id vocabulary still cannot let renderer input shadow main's
    // pane attribution.
    const rendererData = r.data && typeof r.data === 'object' && !Array.isArray(r.data)
      ? r.data as Record<string, unknown>
      : undefined
    // runDisposition is a main-authored provenance verdict. It is intentionally
    // allowlisted in the shared data vocabulary because main later serializes
    // it, but that must not make the same key renderer-authoritative. Strip it
    // before either the generic or Codex sanitizer runs, then add only the
    // value derived above from the exact manager ledger/registry relationship.
    const rendererDataWithoutRunDisposition = rendererData
      ? Object.fromEntries(
          Object.entries(rendererData).filter(([key]) => key !== 'runDisposition'),
        )
      : r.data
    const reportData = runDisposition
      ? {
          ...(rendererDataWithoutRunDisposition &&
            typeof rendererDataWithoutRunDisposition === 'object' &&
            !Array.isArray(rendererDataWithoutRunDisposition)
            ? rendererDataWithoutRunDisposition as Record<string, unknown>
            : {}),
          runDisposition,
        }
      : rendererDataWithoutRunDisposition
    const data = isCodexTranscriptObservation
      ? pickCodexTranscriptObservationData(
          r.name as CodexTranscriptObservationEventName,
          reportData,
        )
      : pickLifecycleData(reportData)
    const correlationIds = isCodexTranscriptObservation
      ? pickCodexTranscriptObservationCorrelationIds(
          r.name as CodexTranscriptObservationEventName,
          r.correlationIds,
          data,
        )
      : rendererCorrelationIds
    const ids = sessionId || correlationIds
      ? { ...(correlationIds ?? {}), ...(sessionId ? { sessionId } : {}) }
      : undefined
    lifecycle.record(
      r.name,
      ids,
      data,
    )

    // Recording is an opt-in second projection of the same sanitized fact, not
    // another observation source. The exact-run equality is load-bearing: the
    // recorder is keyed by stable sessionId, so without this fence an old-run
    // renderer effect would be appended to the successor's recording even
    // though the app journal correctly retained the old sessionRunId.
    if (
      sessionId &&
      isCodexTranscriptObservation &&
      (exactCurrentCodexRun || exactRetiredCodexRun) &&
      rendererSessionRunId
    ) {
      sessionRecorders?.recordCodexTranscriptObservation(sessionId, rendererSessionRunId, {
        schemaVersion: 1,
        name: r.name,
        ...(ids ? { ids } : {}),
        ...(data ? { data } : {}),
      })
    }
  })

  return {
    getCodexTranscriptObservationCompletenessSnapshot: () => ({
      gapTrackingCapped: observationGapTrackingCapped,
    }),
  }
}
