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

// A history chunk in its own (durable) order: entries the pane does not have
// yet, and uuids of entries it already holds, which act as anchors.
type HistoryPlacement = { fresh: Entry } | { anchor: string }

/**
 * Merge a history chunk's new entries into the pane's existing entries,
 * keeping the chunk's order.
 *
 * WHY not `[...fresh, ...existing]`: that assumes every new history entry is
 * older than everything the pane already shows, i.e. the live stream is
 * always AHEAD of the durable read. It can be behind:
 * - OpenCode Terminal holds a queued prompt until its answer commits.
 * - A durable reader that stopped (an event version it refuses) leaves the
 *   pane frozen while OpenCode's tables keep growing; the next history load
 *   (an MCP read re-hydrating a pane in `error`) then brings newer turns.
 * - Any provider's history read can land while a live burst is mid-flight.
 * Prepending put those newer entries above older ones, and since their uuids
 * were then "seen", the live copies were dropped and the misorder was
 * permanent. Anchoring each new entry just before the next entry the pane
 * already holds places it where the durable order says it belongs.
 *
 * When all the chunk's new entries precede the first shared one, the result is
 * exactly the old prepend. Existing entries never move relative to each other.
 *
 * A chunk that shares NO entry with the pane has no anchor to go by, and the
 * stopped-reader case above produces exactly that once the database has grown
 * by more than one chunk (`limit`, 120) since the pane's last live entry: the
 * newest-N chunk no longer reaches back to anything the pane holds. Prepending
 * it put the newest turns ABOVE the pane's older ones, permanently (their
 * uuids are then seen), and everything that reads the tail (Agent
 * Management's activity state, Dispatch titles, Copy Last Response) read an
 * old turn as the latest. So with no anchor, timestamps decide: a chunk whose
 * first entry is strictly newer than the pane's last goes AFTER the window.
 * Anything else (older, equal, or undated on either side) keeps the prepend,
 * which is right for every provider whose live stream is ahead of its
 * durable read (Claude and Codex resume). Appending leaves an unloaded gap
 * between the two when the chunk did not reach back far enough; that is
 * missing rows in order, not rows out of order, and the caller keeps the
 * pagination cursor on the window's oldest entry rather than the chunk's.
 */
function placeHistoryEntries(
  placement: HistoryPlacement[],
  existing: Entry[],
): { entries: Entry[]; appendedAfterWindow: boolean } {
  const position = new Map<string, number>()
  existing.forEach((entry, index) => {
    const uuid = (entry as { uuid?: string }).uuid
    if (uuid && !position.has(uuid)) position.set(uuid, index)
  })
  const anchored = placement.some(item => 'anchor' in item && position.has(item.anchor))
  if (!anchored && existing.length > 0) {
    const fresh = placement.flatMap(item => ('fresh' in item ? [item.fresh] : []))
    if (isStrictlyNewer(fresh, existing)) {
      return { entries: [...existing, ...fresh], appendedAfterWindow: true }
    }
  }
  const merged: Entry[] = []
  let next = 0
  for (const item of placement) {
    if ('fresh' in item) {
      merged.push(item.fresh)
      continue
    }
    const index = position.get(item.anchor)
    // Seen but not in the window (trimmed), or already emitted: no anchor.
    if (index === undefined || index < next) continue
    while (next <= index) merged.push(existing[next++]!)
  }
  while (next < existing.length) merged.push(existing[next++]!)
  return { entries: merged, appendedAfterWindow: false }
}

function entryTime(entry: Entry | undefined): number | null {
  const ts = (entry as { timestamp?: unknown } | undefined)?.timestamp
  if (typeof ts !== 'string') return null
  const ms = Date.parse(ts)
  return Number.isFinite(ms) ? ms : null
}

// The chunk's oldest dated entry against the window's newest dated entry.
// Both sides are in their own chronological order (the chunk in durable
// order, the window as displayed), so comparing the two ends is enough.
function isStrictlyNewer(chunk: readonly Entry[], window: readonly Entry[]): boolean {
  let chunkFirst: number | null = null
  for (const entry of chunk) {
    chunkFirst = entryTime(entry)
    if (chunkFirst !== null) break
  }
  let windowLast: number | null = null
  for (let index = window.length - 1; index >= 0 && windowLast === null; index -= 1) {
    windowLast = entryTime(window[index])
  }
  return chunkFirst !== null && windowLast !== null && chunkFirst > windowLast
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
          transcriptStatus: current.transcriptChannelError ? 'error' : isProvisional ? 'disconnected' : 'ready',
          transcriptError: current.transcriptChannelError ?? (isProvisional
            ? 'Provider session was observed in proxy traffic, but no committed transcript is known yet.'
            : null),
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
        transcriptStatus: current.transcriptChannelError ? 'error' : 'loading',
        transcriptStatusChangedAt: Date.now(),
        transcriptError: current.transcriptChannelError ?? null,
      },
    }
  })

  try {
    const releaseHistorySlot = await acquireInitialHistorySlot()
    // WHY an async wrapper instead of `.finally()` on the IPC promise: if the
    // bridge call throws before returning a promise (a missing or broken
    // `window.api` method), `.finally` is never attached and the slot is
    // never released. With two module-level slots, two such throws stall
    // every later history load in the window, and nothing reports it. The
    // slot still frees as soon as the history read settles, not after
    // `gitWorktrees`.
    const historyRead = (async () => {
      try {
        return await window.api.loadInitialHistory({
          kind,
          cwd: meta.cwd,
          providerSessionId: meta.providerSessionId,
          limit,
        })
      } finally {
        releaseHistorySlot()
      }
    })()
    const [chunk, worktreesResult] = await Promise.all([
      historyRead,
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
      // Bump `toolIndexVersion` once if this bootstrap load actually populated
      // either tool-index map, so Feed's tool-index context picks up the
      // resumed pairings instead of staying on the empty-map identity from
      // emptyRuntime() (feed audit Finding 1).
      let toolIndexChanged = false

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
        if (mapped.length > 0 && marker && !initialOldestMarker) {
          initialOldestMarker = marker
          initialOldestOffset = chunk.offsets?.[rawIndex] ?? null
        }
        for (const entry of mapped) {
          const uuid = (entry as { uuid?: string }).uuid
          // Like the live-burst path, this TAIL loader treats trimmed
          // uuids as already-seen (#375 part B): the bootstrap chunk is
          // the newest slice of the transcript, so a trimmed uuid showing
          // up here means the window trimmed past it — re-appending it
          // out of order would corrupt the feed. Only loadOlderHistory
          // may readmit trimmed uuids.
          if (uuid && (seen.has(uuid) || isUuidTrimmed(sessionId, uuid))) {
            placement.push({ anchor: uuid })
            continue
          }
          if (uuid) seen.add(uuid)
          // Pagination-marker rider — see liveEntryWindow.ts. Stamped at
          // every ingest site so a future trim can re-anchor
          // historyOldestMarker at whatever entry ends up oldest-retained.
          stampHistoryMarker(entry, marker)
          initialEntries.push(entry)
          placement.push({ fresh: entry })
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

      const placed = initialEntries.length > 0
        ? placeHistoryEntries(placement, current.entries)
        : { entries: current.entries, appendedAfterWindow: false }
      // When the chunk went AFTER the window (see placeHistoryEntries), the
      // oldest entry the pane holds is still the window's first, so older
      // pages must keep starting from the window's cursor. Moving it to the
      // chunk's head would page the gap in ABOVE the window: the misorder the
      // append exists to prevent.
      const keepWindowCursor = placed.appendedAfterWindow

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
