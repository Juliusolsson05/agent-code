import type { Entry } from '@shared/types/transcript'
import {
  isCompactBoundaryEntry,
  isCompactSummaryEntry,
  isConversationEntry,
} from '@shared/types/transcript'
import { emptyRuntime, type SessionRuntime } from '@renderer/workspace/workspaceState'
import type { SessionId, SessionMeta } from '@renderer/workspace/types'
import { isCodexRolloutEntry } from '@renderer/workspace/codex/entries'
import {
  codexHistoryMarker,
  codexTurnIdFromRollout,
  mapCodexRolloutToFeedEntries,
  stampCodexTurnId,
} from '@renderer/workspace/codex/rollout'
import {
  claudeHistoryMarker,
  extractEmbeddedClaudeProgressEntry,
} from '@renderer/workspace/claude/history'
import { indexEntryIntoMaps } from '@renderer/workspace/entries/utils'
import { appendFeedDebugLog } from '@renderer/workspace/runtime/feedDebug'
import {
  ghostsToPersist,
  reconcileUpstream,
} from '@renderer/workspace/ghosts'
import {
  deriveAgentWorkContext,
  ingestWorktreeRawEvent,
} from '@shared/work-context/tracker'

import type { WorkspaceSetRuntimes } from '@renderer/workspace/hook/context'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import * as perf from '@renderer/performance/client'
import { hasDurableProviderSession } from '@renderer/workspace/providerSessionIdentity'
import {
  codexEventType,
  codexTurnIdFromEventPayload,
} from '@renderer/workspace/codex/eventCursor'

const INITIAL_HISTORY_CONCURRENCY = 2
let activeInitialHistoryLoads = 0
const initialHistoryWaiters: Array<() => void> = []

// Sessions with a loadInitialHistoryForSession call currently in flight —
// added before the 'loading' write, removed when the load settles (success OR
// failure). The auto-heal reconciler (reconcileStuckTranscriptLoads) reads
// this to tell apart "stuck at loading because its terminal write was dropped"
// (#283 — nothing is driving it, must re-kick) from "legitimately still
// fetching" (a load is running, leave it alone). Module-level because the load
// is fire-and-forget (`void`) and there is no per-call handle to await.
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
  const kind = meta?.kind ?? 'claude'
  if (!meta || (kind !== 'claude' && kind !== 'codex')) return

  if (!hasDurableProviderSession(meta)) {
    setRuntimes(prev => {
      const current = prev[sessionId] ?? emptyRuntime()
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

  // [xcript-diag #283] Trace the load lifecycle. The bug: this sets 'loading'
  // unconditionally, but the terminal 'ready'/'error' below only land if the
  // runtime entry still exists at resolve. If a rebuild/remap drops the key
  // mid-load, the session is stuck at 'loading'. These warns make the timeline
  // (and the exact drop) visible. REMOVE once root cause is fixed.
  console.warn(`[xcript-diag] loading-set session=${sessionId} kind=${kind}`)
  // Mark in-flight BEFORE the 'loading' write so the reconciler never sees a
  // window where status is 'loading' but the load looks idle.
  inFlightInitialLoads.add(sessionId)
  setRuntimes(prev => {
    const current = prev[sessionId] ?? emptyRuntime()
    return {
      ...prev,
      [sessionId]: {
        ...current,
        transcriptStatus: 'loading',
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
        // [xcript-diag #283] SMOKING GUN: the load finished but the runtime
        // entry for this id is gone, so the 'ready' write below is discarded
        // and the pane stays stuck at 'loading'. Log which keys DO exist so we
        // can see what it got remapped/rebuilt to.
        console.warn(
          `[xcript-diag] RESOLVE-DROPPED session=${sessionId} — runtime missing at resolve; 'ready' discarded (STUCK). liveKeys=[${Object.keys(prev).join(',')}]`,
        )
        return prev
      }
      const seen = (refs.seenUuidsRef.current[sessionId] ??= new Set())
      seedSeenFromRuntime(current, seen)

      const initialEntries: Entry[] = []
      let initialOldestMarker: string | null = null
      let workActivity = current.workActivity
      let workContext = current.workContext
      let codexTurnId: string | null = null
      const toolUseIndex = current.toolUseIndex
      const toolResultIndex = current.toolResultIndex

      for (const raw of chunk.entries) {
        workActivity = ingestWorktreeRawEvent({
          state: workActivity,
          raw,
          worktrees,
          sessionCwd: meta.cwd,
        })
        workContext = deriveAgentWorkContext(workActivity)

        if (kind === 'codex') {
          const marker = codexHistoryMarker(raw)
          const turnContextId = codexTurnIdFromRollout(raw)
          if (turnContextId !== null) codexTurnId = turnContextId
          const payloadTurnId = codexTurnIdFromEventPayload(raw)
          if (payloadTurnId !== null) codexTurnId = payloadTurnId
          const mappedRaw = mapCodexRolloutToFeedEntries(raw)
          const mapped = mappedRaw.map(entry => stampCodexTurnId(entry, codexTurnId))
          if (mapped.length > 0 && !initialOldestMarker) initialOldestMarker = marker
          for (const entry of mapped) {
            const uuid = (entry as { uuid?: string }).uuid
            if (uuid && seen.has(uuid)) continue
            if (uuid) seen.add(uuid)
            initialEntries.push(entry)
            indexEntryIntoMaps(entry, toolUseIndex, toolResultIndex)
          }
          const eventType = codexEventType(raw)
          if (
            eventType === 'task_complete' ||
            eventType === 'turn_complete' ||
            eventType === 'turn_aborted'
          ) {
            codexTurnId = null
          }
          continue
        }

        const feedEntry =
          extractEmbeddedClaudeProgressEntry(raw) ??
          (raw as Entry)
        const marker = claudeHistoryMarker(raw)
        if (
          !isConversationEntry(feedEntry) &&
          !isCompactBoundaryEntry(feedEntry) &&
          !isCompactSummaryEntry(feedEntry)
        ) {
          continue
        }
        if (marker && !initialOldestMarker) initialOldestMarker = marker
        const uuid = (feedEntry as { uuid?: string }).uuid
        if (uuid && seen.has(uuid)) continue
        if (uuid) seen.add(uuid)
        initialEntries.push(feedEntry)
        indexEntryIntoMaps(feedEntry, toolUseIndex, toolResultIndex)
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
          totalEntries: chunk.totalEntries ?? initialEntries.length,
          historyOldestMarker: initialOldestMarker ?? current.historyOldestMarker,
          hasOlderHistory: chunk.hasMore,
          transcriptStatus: 'ready',
          transcriptError: null,
          workActivity,
          workContext,
          toolUseIndex,
          toolResultIndex,
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

      console.warn(
        `[xcript-diag] ready-set session=${sessionId} entries=${initialEntries.length}`,
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
        console.warn(
          `[xcript-diag] ERROR-DROPPED session=${sessionId} — runtime missing at error resolve; 'error' discarded (STUCK at 'loading'). msg=${message}`,
        )
        return prev
      }
      return {
        ...prev,
        [sessionId]: {
          ...current,
          transcriptStatus: 'error',
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
  }
}

// Auto-heal for the resume/startup "stuck at loading transcript" class
// (#283/#290). After rehydrate, a Claude/Codex pane can be left at
// transcriptStatus 'loading' with no load actually running, because the load's
// terminal 'ready'/'error' write was discarded when its runtime key was
// dropped or re-keyed mid-flight (the RESOLVE-DROPPED / ERROR-DROPPED paths
// above). The pane then spins forever — or paints an empty "waiting for…" feed
// — until the user manually reloads, which re-runs exactly this loader under a
// now-stable id.
//
// This reconciler automates that manual reload: it scans current runtimes for
// panes that are (a) stuck at 'loading', (b) NOT currently loading, and (c)
// backed by a durable provider session, and re-drives the load for each. It is
// deliberately conservative — it only touches already-broken panes, so in the
// healthy case it is a no-op. It re-uses latestRuntimesRef/latestStateRef
// (the same refs the autosave + feed-debug paths read) so it sees post-commit
// state without needing to thread runtimes through.
//
// WHY re-kicking is safe against an infinite loop: a re-kicked load adds itself
// to inFlightInitialLoads (so the next pass skips it), and on success flips the
// pane to 'ready' (no longer matched). By the time the reconciler runs — a beat
// after rehydrate — the id churn that caused the original drop has settled, so
// the retry lands its write, same as the proven manual-reload path.
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
    if (runtime.transcriptStatus !== 'loading') continue
    if (inFlightInitialLoads.has(sessionId)) continue
    const meta = sessions[sessionId]
    if (!meta || (meta.kind !== 'claude' && meta.kind !== 'codex')) continue
    // Only durable sessions have a transcript to (re)load. Provisional
    // proxy-header sessions are intentionally left to the 'disconnected'
    // path, not healed here.
    if (!hasDurableProviderSession(meta)) continue
    reKicked++
    console.warn(
      `[xcript-heal #283] re-driving stuck transcript load session=${sessionId} kind=${meta.kind}`,
    )
    void loadInitialHistoryForSession({ sessionId, refs, setRuntimes, meta })
  }
  return reKicked
}
