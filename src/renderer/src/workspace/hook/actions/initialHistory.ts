import { DEFAULT_PROVIDER, isAgentProviderKind } from '@shared/types/providerKind'
import type { Entry } from '@shared/types/transcript'
import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import type { SessionId, SessionMeta } from '@renderer/workspace/types'
import { getRendererProviderCapabilities } from '@providers/registry.renderer.capabilities'
import {
  isUuidTrimmed,
  releaseTrimmedUuid,
} from '@renderer/session-runtime/liveEntryWindow'
import {
  admitMappedEntries,
  isPaginationAnchor,
  latestCommittedTimestamp,
  reindexToolsAfterMerge,
  type CommittedSeenLedger,
} from '@renderer/session-runtime/ingest/committedRecords'
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
import { placeHistoryEntries, type HistoryPlacement } from '@renderer/session-runtime/ingest/historyPlacement'
import type { SessionFeed } from '@shared/sessionFeed/SessionFeed'
import { ipcSessionFeed } from '@renderer/features/sessionFeed/IpcSessionFeed'
import { reduceGhostLogSansSuperseded } from 'agent-transcript-parser/ghost'
import type { GhostEntry } from 'agent-transcript-parser/ghost'

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

/**
 * The pane's persisted ghosts, reduced to the latest non-superseded ghost per
 * uuid, or an empty map when there are none or the read fails.
 *
 * WHY here (#1225): the ghost system exists for crash-resume, where Agent
 * Code died mid-turn and the committed transcript ends before the turn the
 * proxy saw. A restored pane loads its history HERE, under its persisted id.
 * The only other reader (`spawn`) runs under an id main just minted, so since
 * the July recovery rewrite no restore had read its log at all.
 *
 * Non-fatal on purpose: a missing or unreadable log only loses provisional
 * rows, never the committed history this loader exists to load.
 */
async function readPersistedGhosts(sessionId: SessionId): Promise<Map<string, GhostEntry>> {
  try {
    const raw = await window.api.ghostRead?.(sessionId)
    if (!Array.isArray(raw) || raw.length === 0) return new Map()
    return reduceGhostLogSansSuperseded(raw as never[]) as Map<string, GhostEntry>
  } catch (err) {
    console.warn('[ghost] restore read failed:', err)
    return new Map()
  }
}

export async function loadInitialHistoryForSession({
  sessionId,
  refs,
  setRuntimes,
  limit = 120,
  meta: metaOverride,
  feed = ipcSessionFeed,
  preserveStatusUntilLoaded = false,
}: {
  sessionId: SessionId
  refs: WorkspaceRefs
  setRuntimes: WorkspaceSetRuntimes
  limit?: number
  meta?: SessionMeta
  // Where the chunk is read from: the SessionFeed contract (#1177), not a raw
  // `window.api` call, so the history read goes through the same seam as
  // every other session read and a shared ingest core can later drive it
  // over either transport.
  //
  // WHY a default rather than a required argument: this loader runs from a
  // dozen places outside React (session actions, rehydrate, adoption,
  // hydrateTranscript, routing recovery) that hold `refs` but no feed, and
  // the desktop has exactly one feed — the `ipcSessionFeed` module constant
  // main.tsx hands to SessionFeedProvider. Defaulting to that same instance
  // is reading through the feed; threading it through every caller would add
  // a parameter that can only ever hold one value.
  //
  // A scoped recovery overrides it with an owner/source-validated read while
  // retaining the existing mapper, UUID ledger, tool pairing and optimistic
  // reconciliation (this used to be the `readHistory` injection point).
  feed?: Pick<SessionFeed, 'loadHistory'>
  // Routing repair owns its own warning. A denied/stale repair read is not
  // evidence that the provider's committed transcript channel has failed.
  preserveStatusUntilLoaded?: boolean
}): Promise<boolean> {
  const meta = metaOverride ?? refs.stateRef.current.sessions[sessionId]
  const kind = meta?.kind ?? DEFAULT_PROVIDER
  // WHY provider-native terminal runtimes (OpenCode Terminal) load history
  // like every other agent: the pane stays a raw TUI, but the conversation in
  // `runtime.entries` is what the rest of the app reads — Copy Last Response,
  // View Prompts, agent status rows, Close Old Agents, and the agent
  // management MCP's `hydrateTranscriptWithoutWaking`. Skipping it left a
  // reloaded terminal pane with no history until its next turn, and a parked
  // one with none at all.
  //
  // The two reasons this used to be skipped no longer hold. History came from
  // `opencode export`, a Bun child that serializes the whole session per call;
  // it is now two indexed reads of OpenCode's database (see
  // `@providers/opencode/runtime/opencodeHistory`). And the rendered feed
  // cannot leak onto the terminal: `getEffectiveAgentSurface` pins the
  // runtime to the terminal surface and `commandAllowedByRenderedViewPolicy`
  // hides every feed-only command for it, whatever `entries` holds.
  if (!meta || !isAgentProviderKind(kind)) return false

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
          transcriptStatus: current.transcriptChannelError ? 'error' : isProvisional ? 'disconnected' : 'ready',
          transcriptError: current.transcriptChannelError ?? (isProvisional
            ? 'Provider session was observed in proxy traffic, but no committed transcript is known yet.'
            : null),
        },
      }
    })
    return false
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
  // ── A LOAD BELONGS TO THE CONVERSATION IT READ (Astra review, finding 1) ──
  // A pane that follows its runtime into another provider session (Pi /new,
  // /resume, /fork) rebinds its identity and then resets its history window.
  // A load of the OLD session that resolves after either would merge the old
  // conversation's rows into the new one's window (and View Prompts and the
  // orchestration reads would serve them). So refuse to apply a result,
  // success or failure, once the pane is no longer that conversation.
  //
  // WHY compare against the id this load READ, and only once the pane has a
  // different one: a pane routinely gains its id while a load is in flight —
  // an OpenCode runtime pre-creates its session at start, and a scoped
  // recovery passes a meta override naming the transcript before the store
  // holds it. A first version compared the store's id at start with the id at
  // the end, and threw those legitimate loads away (no id → the same id is a
  // BINDING, not a switch).
  //
  // WHY not the history window's generation as well: it was tried, and it
  // threw away OpenCode Terminal's startup load, whose runtime resets the
  // window while that load is in flight. That reset re-delivers rows but not
  // the loader's pagination facts (totalEntries, hasOlderHistory), so the pane
  // lost them. The identity alone is enough: every Pi session move rebinds
  // the id BEFORE its reset, so a load of the old session is caught here, and
  // a load that started after the rebind read the new session — its rows are
  // the right ones, and the dedup set absorbs the overlap with the replay.
  const readProviderSessionId = meta.providerSessionId
  const superseded = (): boolean => {
    const current = refs.stateRef.current.sessions[sessionId]?.providerSessionId
    return current !== undefined && current !== readProviderSessionId
  }
  // A superseded load is done, not failed: the reset (and the new session's
  // own rows) own the window now. Settle the status it set to 'loading' so
  // neither the pane nor the stuck-load reconciler waits on it forever (#283).
  const settleSuperseded = (): false => {
    setRuntimes(prev => {
      const current = prev[sessionId]
      if (!current) {
        loadOutcome = 'dropped-superseded'
        return prev
      }
      loadOutcome = 'superseded'
      if (preserveStatusUntilLoaded) return prev
      return {
        ...prev,
        [sessionId]: {
          ...current,
          transcriptStatus: current.transcriptChannelError ? 'error' : 'ready',
          transcriptStatusChangedAt: Date.now(),
          transcriptError: current.transcriptChannelError ?? null,
        },
      }
    })
    return false
  }
  if (!preserveStatusUntilLoaded) setRuntimes(prev => {
    const current = prev[sessionId]
    if (!current) return prev
    return {
      ...prev,
      [sessionId]: {
        ...current,
        transcriptStatus: current.transcriptChannelError ? 'error' : 'loading',
        transcriptStatusChangedAt: Date.now(),
        transcriptError: current.transcriptChannelError ?? null,
      },
    }
  })

  try {
    const releaseHistorySlot = await acquireInitialHistorySlot()
    // WHY an async wrapper instead of `.finally()` on the read's promise: if
    // the feed call throws before returning a promise (a missing or broken
    // `window.api` method behind it, or an override), `.finally` is never attached and the slot is
    // never released. With two module-level slots, two such throws stall
    // every later history load in the window, and nothing reports it. The
    // slot still frees as soon as the history read settles, not after
    // `gitWorktrees`.
    const historyRead = (async () => {
      try {
        return await feed.loadHistory({
          sessionId,
          transcript: { kind, cwd: meta.cwd, providerSessionId: meta.providerSessionId },
          limit,
        })
      } finally {
        releaseHistorySlot()
      }
    })()
    const [chunk, worktreesResult, persistedGhosts] = await Promise.all([
      historyRead,
      window.api.gitWorktrees(meta.cwd),
      readPersistedGhosts(sessionId),
    ])
    const worktrees = worktreesResult.ok ? worktreesResult.worktrees : []
    if (superseded()) {
      span.end({ fetched: chunk.entries.length, hasMore: chunk.hasMore, superseded: true })
      return settleSuperseded()
    }

    setRuntimes(prev => {
      const current = prev[sessionId]
      if (!current) {
        loadOutcome = 'dropped-ready'
        return prev
      }
      loadOutcome = 'ready'
      const seen = (refs.seenUuidsRef.current[sessionId] ??= new Set())
      seedSeenFromRuntime(current, seen)
      const seenLedger: CommittedSeenLedger = {
        seen,
        isTrimmed: uuid => isUuidTrimmed(sessionId, uuid),
        releaseTrimmed: uuid => releaseTrimmedUuid(sessionId, uuid),
      }

      const initialEntries: Entry[] = []
      const placement: HistoryPlacement[] = []
      let initialOldestMarker: string | null = null
      // Byte offset of the marker's line (chunk.offsets is parallel to
      // chunk.entries); echoed to the loader so the first older page is
      // anchored exactly. See historyLoader.ts for why a marker alone is
      // not enough.
      let initialOldestOffset: number | null = null
      let workActivity = current.workActivity
      let workContext = current.workContext
      // Registry-owned mapper (#394 phase 2b); chunk-scoped, so the
      // Codex turn cursor starts null exactly like the old local
      // variable did.
      const mapper = getRendererProviderCapabilities(kind).createTranscriptEntryMapper()
      const toolUseIndex = current.toolUseIndex
      const toolResultIndex = current.toolResultIndex

      for (const [rawIndex, raw] of chunk.entries.entries()) {
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
        if (!initialOldestMarker && isPaginationAnchor(mapped, marker)) {
          initialOldestMarker = marker
          initialOldestOffset = chunk.offsets?.[rawIndex] ?? null
        }
        // The `tail` rule (session-runtime/ingest/committedRecords.ts): like
        // the live-burst path, this TAIL loader treats trimmed uuids as
        // already-seen (#375 part B) — the bootstrap chunk is the newest
        // slice of the transcript, so a trimmed uuid showing up here means the
        // window trimmed past it, and re-appending it out of order would
        // corrupt the feed. Only loadOlderHistory may readmit trimmed uuids.
        // Already-held uuids become placement anchors; each admitted entry is
        // stamped with its line's marker so a future trim can re-anchor
        // historyOldestMarker at whatever entry ends up oldest-retained.
        initialEntries.push(...admitMappedEntries(mapped, marker, 'tail', seenLedger, { placement }).admitted)
      }

      // The pane's own ghost log fills slots the runtime has not produced
      // itself (#1225). A ghost already in memory wins: it can only be fresher
      // than what was persisted. The loaded tail then supersedes the ghosts
      // whose turns it committed, and only what that CHANGED is appended
      // back, diffed against the merged state rather than the empty runtime,
      // so a restore does not re-append the whole log it just read (#731).
      let loadedGhosts = current.ghosts
      if (persistedGhosts.size > 0) {
        const merged = new Map(current.ghosts)
        for (const [uuid, ghost] of persistedGhosts) {
          if (!merged.has(uuid)) merged.set(uuid, ghost)
        }
        loadedGhosts = merged
      }
      let nextGhosts = loadedGhosts
      for (const entry of initialEntries) {
        nextGhosts = reconcileUpstream(entry, nextGhosts)
      }
      for (const ghost of ghostsToPersist(loadedGhosts, nextGhosts)) {
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
      const lastJsonlEntryAt = latestCommittedTimestamp(current.lastJsonlEntryAt, initialEntries)

      const placed = initialEntries.length > 0
        ? placeHistoryEntries(placement, current.entries)
        : { entries: current.entries, appendedAfterWindow: false, keptWindowHead: current.entries.length > 0 }
      // Fold the chunk's tool blocks AFTER placement, in window order, so a
      // chunk row can never overwrite a newer live pairing that shares its id
      // (reindexToolsAfterMerge, #1177). A chunk with no tool block leaves
      // the maps and the version alone; one that has any bumps
      // `toolIndexVersion` so Feed's tool-index context picks up the resumed
      // pairings instead of staying on the empty-map identity from
      // emptyRuntime() (feed audit Finding 1).
      const toolIndexChanged = reindexToolsAfterMerge(initialEntries, placed.entries, { toolUseIndex, toolResultIndex })
      // ── THE CURSOR NAMES THE OLDEST ENTRY THE PANE HOLDS (#910 item 3) ──
      // So the only question is whether this load changed which entry that is,
      // and `placeHistoryEntries` answers it by observation: `keptWindowHead`
      // is true exactly when the merged result still begins with the window's
      // first row.
      //
      // Two cases it covers, which used to be two separate rules:
      //   - the chunk went AFTER the window (the strictly-newer append). The
      //     pane's oldest row is unchanged, so older pages must keep starting
      //     from the window's cursor; moving it to the chunk's head would page
      //     the gap in ABOVE the window, the misorder the append prevents.
      //   - the chunk added nothing (an all-anchor re-read of a tail the
      //     window ALREADY HOLDS). With a window of [c,d] that had paged back
      //     to [a,b] and then re-read its own [g,h], the marker moved to `g`
      //     and the next older page landed above everything —
      //     [e,f,a,b,c,d,g,h].
      //
      // WHY this replaced `appendedAfterWindow || !addedFreshEntries` (#1081
      // review, finding 1): that pair was true before item 2's prefix flush,
      // when a chunk starting with a fresh row really did put it at merged[0].
      // After the flush the merged head is the WINDOW's head while
      // `addedFreshEntries` is still true — so the cursor jumped to the
      // chunk's head for a row that is no longer the oldest, and the next
      // older page prepended above a row that precedes it. The fix to item 2
      // had quietly recreated item 3 from the other side.
      const keepWindowCursor = placed.keptWindowHead

      const nextRuntime = appendFeedDebugLog(
        {
          ...current,
          entries: placed.entries,
          // Seed totalEntries from the loader. The loader counts every
          // usable JSONL record at read time (parsed.entries.length
          // before the tail slice), so this is the honest denominator
          // for "you are at entry X of Y" the moment the session opens.
          // Falls back to the visible-buffer length when the loader
          // didn't supply a count — e.g. when initial-history was
          // called for a session with no on-disk transcript yet.
          totalEntries: resolvedTotalEntries,
          historyOldestMarker: keepWindowCursor
            ? current.historyOldestMarker
            : initialOldestMarker ?? current.historyOldestMarker,
          // The `initialOldestMarker !== null` half is an EQUIVALENT MUTANT
          // today and no test pins it (#1081 review, finding 4). The marker
          // and the offset are assigned together, so a null marker implies a
          // null offset; and `keepWindowCursor` can only be false with a null
          // marker when the window was empty, where `current.historyOldestOffset`
          // is null too. It stays because it states the invariant the two
          // lines share — the offset belongs to the marker directly above it,
          // and must never be dropped while that marker is retained.
          historyOldestOffset: !keepWindowCursor && initialOldestMarker !== null
            ? initialOldestOffset
            : current.historyOldestOffset,
          hasOlderHistory: chunk.hasMore,
          // The projection can remain readable after the event reader stops
          // for good. Snapshot success repairs a history failure only; it
          // cannot certify ongoing observation or follow TUI navigation.
          transcriptStatus: current.transcriptChannelError ? 'error' : 'ready',
          transcriptStatusChangedAt: Date.now(),
          transcriptError: current.transcriptChannelError ?? null,
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
    return loadOutcome === 'ready'
  } catch (err) {
    span.fail(err)
    const message = err instanceof Error ? err.message : String(err)
    console.warn('[history] load initial failed', err)
    // A failure to read the conversation the pane has since LEFT says nothing
    // about the one it shows now; marking that one 'error' would be a lie.
    if (superseded()) return settleSuperseded()
    if (!preserveStatusUntilLoaded) setRuntimes(prev => {
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
    return false
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
