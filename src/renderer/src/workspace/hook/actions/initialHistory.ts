import { DEFAULT_PROVIDER, isAgentProviderKind } from '@shared/types/providerKind'
import type { Entry } from '@shared/types/transcript'
import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import type { SessionId, SessionMeta } from '@renderer/workspace/types'
import { getRendererProviderCapabilities } from '@providers/registry.renderer.capabilities'
import { indexEntryIntoMaps } from '@renderer/session-runtime/entries'
import {
  isUuidTrimmed,
  stampHistoryMarker,
} from '@renderer/session-runtime/liveEntryWindow'
import { appendFeedDebugLog } from '@renderer/session-runtime/feedDebug'
import {
  ghostsToPersist,
  reconcileUpstream,
} from '@renderer/session-runtime/ghosts'
import {
  deriveAgentWorkContext,
  ingestWorktreeRawEvent,
} from '@shared/work-context/tracker'

import type { WorkspaceSetRuntimes } from '@renderer/workspace/hook/context'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import * as perf from '@renderer/performance/client'
import { hasDurableProviderSession } from '@renderer/workspace/providerSessionIdentity'
import { reportLifecycle } from '@renderer/lifecycle/report'

const INITIAL_HISTORY_CONCURRENCY = 2
let activeInitialHistoryLoads = 0
const initialHistoryWaiters: Array<() => void> = []

// Sessions with a loadInitialHistoryForSession call currently in flight —
// added before the 'loading' write, removed when the load settles (success OR
// failure). The auto-heal reconciler (reconcileStuckTranscriptLoads) reads
// this to tell apart "stuck because its terminal write was dropped" (#283 —
// nothing is driving it, must re-kick) from "legitimately still fetching" (a
// load is running, leave it alone). Module-level because the load is
// fire-and-forget (`void`) and there is no per-call handle to await.
const inFlightInitialLoads = new Set<SessionId>()

async function acquireInitialHistorySlot(): Promise<() => void> {
  if (activeInitialHistoryLoads < INITIAL_HISTORY_CONCURRENCY) {
    activeInitialHistoryLoads++
    return releaseInitialHistorySlot
  }

  // WHY this limiter is renderer-local instead of buried in main: the burst
  // happens because restore/rehydrate loops fire one IPC per pane at once.
  // Keeping the queue here protects main across all initial-history callers
  // without changing the public IPC contract or making unrelated explicit
  // older-history pagination wait behind a cold-start restore storm.
  await new Promise<void>(resolve => {
    initialHistoryWaiters.push(resolve)
  })
  return releaseInitialHistorySlot
}

function releaseInitialHistorySlot(): void {
  const next = initialHistoryWaiters.shift()
  if (next) {
    // Transfer this slot directly to the waiter. If we decremented first and
    // let the waiter increment in a later microtask, a fresh caller could slip
    // through the gap and temporarily run three cold-start history loads under
    // a limit of two.
    next()
    return
  }
  activeInitialHistoryLoads = Math.max(0, activeInitialHistoryLoads - 1)
}

function seedSeenFromRuntime(runtime: SessionRuntime, seen: Set<string>): void {
  for (const entry of runtime.entries) {
    const uuid = (entry as { uuid?: string }).uuid
    if (uuid) seen.add(uuid)
  }
}

export async function loadInitialHistoryForSession({
  sessionId,
  refs,
  setRuntimes,
  limit = 120,
  meta: metaOverride,
}: {
  sessionId: SessionId
  refs: WorkspaceRefs
  setRuntimes: WorkspaceSetRuntimes
  limit?: number
  meta?: SessionMeta
}): Promise<void> {
  const meta = metaOverride ?? refs.stateRef.current.sessions[sessionId]
  const kind = meta?.kind ?? DEFAULT_PROVIDER
  if (!meta || !isAgentProviderKind(kind)) return

  if (!hasDurableProviderSession(meta)) {
    setRuntimes(prev => {
      const current = prev[sessionId]
      // WHY history hydration never creates session ownership: recovery may
      // finish after the user closed the pane. A metadata override proves
      // which transcript to read, not that a renderer runtime still exists.
      if (!current) return prev
      const isProvisional = meta.providerSessionIdSource === 'proxy-header'
      return {
        ...prev,
        [sessionId]: {
          ...current,
          transcriptStatus: isProvisional ? 'disconnected' : 'ready',
          transcriptError: isProvisional
            ? 'Provider session was observed in proxy traffic, but no committed transcript is known yet.'
            : null,
        },
      }
    })
    return
  }

  const span = perf.span('workspace.history.loadInitial', {
    sessionId,
    kind,
    limit,
  })

  // Mark in-flight BEFORE the 'loading' write so the reconciler never sees a
  // window where status is 'loading' but the load looks idle.
  inFlightInitialLoads.add(sessionId)
  // #283 was "startup/resume stuck at 'loading transcript' until a manual
  // reload", caused by an ASYMMETRIC state write: 'loading' set unconditionally,
  // but the terminal 'ready'/'error' writes guarded by `if (!current) return
  // prev`. A dropped runtime key therefore stranded the pane forever. Bracketing
  // the load with start/end makes that asymmetry directly observable — a
  // history.load.start with no matching end IS the bug, with no inference
  // required.
  const historyStartedAt = Date.now()
  reportLifecycle('history.load.start', sessionId, { kind })
  // Default is deliberately 'no-terminal-write'. That value surviving to the
  // finally block means neither the ready nor the error write ran at all — the
  // #283 "marked-but-never-loaded" half. `dropped-*` means the write RAN but
  // its runtime key was gone — the "dropped write" half. Two distinct defects
  // that presented identically as a pane spinning on 'loading transcript'.
  // WHY a mutable local rather than reading state back: this is set from inside
  // the setRuntimes updaters below, which is safe ONLY because the workspace
  // store invokes updaters synchronously. If runtimes ever move behind a
  // deferred setter, `history.load.end` would silently report
  // 'no-terminal-write' forever — and that value is the #283 fingerprint, so a
  // false positive here is worse than no signal. Flagged in review; the
  // synchronous contract is asserted by the test below rather than assumed.
  let loadOutcome = 'no-terminal-write'
  let loadedEntryCount = 0
  setRuntimes(prev => {
    const current = prev[sessionId]
    if (!current) return prev
    return {
      ...prev,
      [sessionId]: {
        ...current,
        transcriptStatus: 'loading',
        transcriptStatusChangedAt: Date.now(),
        transcriptError: null,
      },
    }
  })

  try {
    const releaseHistorySlot = await acquireInitialHistorySlot()
    const [chunk, worktreesResult] = await Promise.all([
      window.api.loadInitialHistory({
        kind,
        cwd: meta.cwd,
        providerSessionId: meta.providerSessionId,
        limit,
      }).finally(releaseHistorySlot),
      window.api.gitWorktrees(meta.cwd),
    ])
    const worktrees = worktreesResult.ok ? worktreesResult.worktrees : []

    setRuntimes(prev => {
      const current = prev[sessionId]
      if (!current) {
        loadOutcome = 'dropped-ready'
        return prev
      }
      loadOutcome = 'ready'
      const seen = (refs.seenUuidsRef.current[sessionId] ??= new Set())
      seedSeenFromRuntime(current, seen)

      const initialEntries: Entry[] = []
      let initialOldestMarker: string | null = null
      let workActivity = current.workActivity
      let workContext = current.workContext
      // Registry-owned mapper (#394 phase 2b); chunk-scoped, so the
      // Codex turn cursor starts null exactly like the old local
      // variable did.
      const mapper = getRendererProviderCapabilities(kind).createTranscriptEntryMapper()
      const toolUseIndex = current.toolUseIndex
      const toolResultIndex = current.toolResultIndex
      // Bump `toolIndexVersion` once if this bootstrap load actually populated
      // either tool-index map, so Feed's tool-index context picks up the
      // resumed pairings instead of staying on the empty-map identity from
      // emptyRuntime() (feed audit Finding 1).
      let toolIndexChanged = false

      for (const raw of chunk.entries) {
        workActivity = ingestWorktreeRawEvent({
          state: workActivity,
          raw,
          worktrees,
          sessionCwd: meta.cwd,
        })
        workContext = deriveAgentWorkContext(workActivity)

        const { entries: mapped, historyMarker: marker } = mapper.map(raw)
        // Marker policy (site-owned): the FIRST kept line of the
        // bootstrap chunk is the pagination anchor for older-history
        // loads.
        if (mapped.length > 0 && marker && !initialOldestMarker) {
          initialOldestMarker = marker
        }
        for (const entry of mapped) {
          const uuid = (entry as { uuid?: string }).uuid
          // Like the live-burst path, this TAIL loader treats trimmed
          // uuids as already-seen (#375 part B): the bootstrap chunk is
          // the newest slice of the transcript, so a trimmed uuid showing
          // up here means the window trimmed past it — re-appending it
          // out of order would corrupt the feed. Only loadOlderHistory
          // may readmit trimmed uuids.
          if (uuid && (seen.has(uuid) || isUuidTrimmed(sessionId, uuid))) continue
          if (uuid) seen.add(uuid)
          // Pagination-marker rider — see liveEntryWindow.ts. Stamped at
          // every ingest site so a future trim can re-anchor
          // historyOldestMarker at whatever entry ends up oldest-retained.
          stampHistoryMarker(entry, marker)
          initialEntries.push(entry)
          if (indexEntryIntoMaps(entry, toolUseIndex, toolResultIndex)) {
            toolIndexChanged = true
          }
        }
      }

      let nextGhosts = current.ghosts
      for (const entry of initialEntries) {
        nextGhosts = reconcileUpstream(entry, nextGhosts)
      }
      for (const ghost of ghostsToPersist(current.ghosts, nextGhosts)) {
        window.api.ghostAppend(sessionId, ghost)
      }

      // Bootstrap-load equivalent of the live-ingest stamping in
      // useIpcSubscriptions.ts. selectMergedEntries gates orphan
      // ghost rendering against this timestamp; on resume we need
      // it primed from the loaded JSONL tail so a ghost from the
      // previous session whose updatedAt is older than the freshest
      // loaded JSONL entry stays correctly hidden, while a ghost
      // newer than every loaded entry (the
      // "JSONL-stopped-mid-turn before the previous run died" case)
      // surfaces as expected.
      // Captured for the history.load.end breadcrumb. Plain statement rather
      // than an assignment folded into the object literal below: this value is
      // read by a diagnostic, and a diagnostic must never be the reason a
      // production expression is hard to read.
      const resolvedTotalEntries = chunk.totalEntries ?? initialEntries.length
      loadedEntryCount = resolvedTotalEntries
      let lastJsonlEntryAt = current.lastJsonlEntryAt
      for (const entry of initialEntries) {
        const ts = (entry as { timestamp?: unknown }).timestamp
        if (typeof ts !== 'string') continue
        const ms = Date.parse(ts)
        if (!Number.isFinite(ms)) continue
        if (lastJsonlEntryAt === null || ms > lastJsonlEntryAt) {
          lastJsonlEntryAt = ms
        }
      }

      const nextRuntime = appendFeedDebugLog(
        {
          ...current,
          entries: initialEntries.length > 0
            ? [...initialEntries, ...current.entries]
            : current.entries,
          // Seed totalEntries from the loader. The loader counts every
          // usable JSONL record at read time (parsed.entries.length
          // before the tail slice), so this is the honest denominator
          // for "you are at entry X of Y" the moment the session opens.
          // Falls back to the visible-buffer length when the loader
          // didn't supply a count — e.g. when initial-history was
          // called for a session with no on-disk transcript yet.
          totalEntries: resolvedTotalEntries,
          historyOldestMarker: initialOldestMarker ?? current.historyOldestMarker,
          hasOlderHistory: chunk.hasMore,
          transcriptStatus: 'ready',
          transcriptStatusChangedAt: Date.now(),
          transcriptError: null,
          workActivity,
          workContext,
          toolUseIndex,
          toolResultIndex,
          toolIndexVersion: toolIndexChanged
            ? current.toolIndexVersion + 1
            : current.toolIndexVersion,
          ghosts: nextGhosts,
          lastJsonlEntryAt,
        },
        {
          layer: 'STATE',
          kind: 'initial_history',
          summary: `initial history +${initialEntries.length}`,
          data: {
            rawEntries: chunk.entries.length,
            mappedEntries: initialEntries.length,
            hasMore: chunk.hasMore,
          },
        },
      )

      return { ...prev, [sessionId]: nextRuntime }
    })

    span.end({
      fetched: chunk.entries.length,
      hasMore: chunk.hasMore,
    })
  } catch (err) {
    span.fail(err)
    const message = err instanceof Error ? err.message : String(err)
    console.warn('[history] load initial failed', err)
    setRuntimes(prev => {
      const current = prev[sessionId]
      if (!current) {
        loadOutcome = 'dropped-error'
        return prev
      }
      loadOutcome = 'error'
      return {
        ...prev,
        [sessionId]: {
          ...current,
          transcriptStatus: 'error',
          transcriptStatusChangedAt: Date.now(),
          transcriptError: message,
        },
      }
    })
  } finally {
    // Always clear in-flight, even on the dropped-write paths above. If the
    // terminal write was discarded the runtime is left at 'loading' but the
    // load is genuinely done, so the reconciler must be allowed to see it as
    // idle-and-stuck and re-kick it.
    inFlightInitialLoads.delete(sessionId)
    reportLifecycle('history.load.end', sessionId, {
      kind,
      status: loadOutcome,
      entryCount: loadedEntryCount,
      durationMs: Date.now() - historyStartedAt,
    })
  }
}

// Auto-heal for the resume/startup "stuck transcript" class (#283/#290). After
// rehydrate, a Claude/Codex pane can be left either spinning at 'loading' or
// painting an empty "waiting for…" feed (committed entries never arrived) even
// though the conversation exists on disk. Both come from the same upstream
// failure: the committed-transcript load's terminal write was discarded when
// its runtime key was dropped/re-keyed mid-flight (the RESOLVE-DROPPED /
// ERROR-DROPPED paths above), or rehydrate marked the pane without ever kicking
// a loader. The renderer is correct — it shows "waiting" because the runtime
// genuinely holds no entries — so the fix is upstream: re-run the load, exactly
// what a manual reload does.
//
// This reconciler automates that reload. It re-drives the load for any pane
// that is backed by a DURABLE provider session, is NOT currently loading, and
// is visibly stuck — either status 'loading' (spinner) or zero entries (empty
// feed). It is conservative: re-loading is idempotent (seen-uuid dedup) and a
// genuinely empty new session simply re-fetches its (few) entries, so the
// healthy case is a cheap no-op. Provisional proxy-header sessions are skipped
// (hasDurableProviderSession === false) — they have no durable id to reload and
// are owned by the 'disconnected' recovery path instead.
//
// WHY no infinite loop: a re-kicked load adds itself to inFlightInitialLoads
// (next pass skips it) and on success populates entries / flips to 'ready' (no
// longer matched). By the time this runs — a beat after rehydrate — the id
// churn that caused the original drop has settled, so the retry lands, same as
// the proven manual-reload path.
export function reconcileStuckTranscriptLoads({
  refs,
  setRuntimes,
}: {
  refs: WorkspaceRefs
  setRuntimes: WorkspaceSetRuntimes
}): number {
  const runtimes = refs.latestRuntimesRef.current
  const sessions = refs.latestStateRef.current.sessions
  let reKicked = 0
  for (const [sessionId, runtime] of Object.entries(runtimes) as Array<
    [SessionId, (typeof runtimes)[SessionId]]
  >) {
    if (inFlightInitialLoads.has(sessionId)) continue
    const stuckSpinner = runtime.transcriptStatus === 'loading'
    const emptyFeed = runtime.entries.length === 0
    if (!stuckSpinner && !emptyFeed) continue
    const meta = sessions[sessionId]
    const kind = meta?.kind ?? DEFAULT_PROVIDER
    if (!meta || !isAgentProviderKind(kind)) continue
    // Only durable sessions have a reloadable transcript. Provisional
    // proxy-header sessions are left to the 'disconnected' path.
    if (!hasDurableProviderSession(meta)) continue
    reKicked++
    void loadInitialHistoryForSession({ sessionId, refs, setRuntimes, meta })
  }
  return reKicked
}
