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
/**
 * Exported for tests only — nothing but the loader below may call it.
 *
 * WHY the direct export rather than driving it through the loader, which the
 * cursor half of #910 does successfully: this rule's inputs are a chunk/window
 * PAIR, and the interesting ones (a trimmed anchor, an anchor the window holds
 * out of durable order) take a specific paging history to stage through a
 * seeded database. The loader seam is better where it can reach — and finding
 * 2 of the #1081 review is the cost of this one: a hand-authored placement let
 * a case be pinned whose own timestamps contradicted the asserted order,
 * because nothing forced the question "can a chunk actually look like this?".
 * Author placements in DURABLE ORDER, or the test is about nothing.
 *
 * `keptWindowHead` reports whether the merged result still begins with the
 * window's first entry. That, not "did this load add anything", is what the
 * pagination cursor needs — see its use below.
 */
export function placeHistoryEntries(
  placement: HistoryPlacement[],
  existing: Entry[],
): { entries: Entry[]; appendedAfterWindow: boolean; keptWindowHead: boolean } {
  const position = new Map<string, number>()
  existing.forEach((entry, index) => {
    const uuid = (entry as { uuid?: string }).uuid
    if (uuid && !position.has(uuid)) position.set(uuid, index)
  })
  const anchored = placement.some(item => 'anchor' in item && position.has(item.anchor))
  if (!anchored && existing.length > 0) {
    const fresh = placement.flatMap(item => ('fresh' in item ? [item.fresh] : []))
    if (isStrictlyNewer(fresh, existing)) {
      return { entries: [...existing, ...fresh], appendedAfterWindow: true, keptWindowHead: true }
    }
  }
  const merged: Entry[] = []
  let next = 0
  for (const [at, item] of placement.entries()) {
    if ('fresh' in item) {
      // ── FLUSH THE RETAINED PREFIX FIRST (#910 item 2) ──
      // A fresh entry belongs before the next anchor it shares with the
      // window. This used to push the fresh row straight out, so a pane
      // holding [a,c] receiving [b,c] produced [b,a,c]: `b` emitted, then `a`
      // and `c` flushed behind it. Nothing errors, uuid dedup makes the order
      // permanent, and the user simply reads the conversation wrong.
      //
      // WHY the flush is bounded by TIME and not only by the anchor (#1081
      // review, finding 2): "before the anchor" does not mean "after
      // everything the window holds ahead of it". The window can hold a row
      // the chunk skips, and that row can fall on either side of the fresh
      // one:
      //
      //   window [a,c]   chunk [b, *c]        a < b  → flush a, then b   ✓
      //   window [b,d,e] chunk [*b, c, *e, g] d > c  → b, c, d, e, g     ✓
      //
      // Flushing unconditionally gets the first right and the second wrong
      // (b,d,c,e,g); flushing nothing gets the second right and the first
      // wrong. The timestamps are already on these entries and are exactly
      // what tells the two families apart, so the loop stops at the first
      // retained row that is strictly NEWER than the fresh one. When either
      // side is undated the comparison is false and the row is flushed, which
      // is the pre-timestamp behaviour and the better default: a fuzz over
      // ~48k random chunk/window pairs found flushing beat not flushing by
      // 12,275 to 1,397 on chronological inversions.
      //
      // The anchor bound stays on top of it. With no following anchor the
      // chunk shares nothing further with the window and the prepend is
      // deliberate — see the unanchored case above, where a chunk that does
      // not reach back far enough must not be interleaved on a guess.
      const anchorIndex = nextAnchorIndex(placement, at + 1, position, next)
      if (anchorIndex !== null) {
        while (next < anchorIndex && !isAfter(existing[next], item.fresh)) merged.push(existing[next++]!)
      }
      merged.push(item.fresh)
      continue
    }
    const index = position.get(item.anchor)
    // Seen but not in the window (trimmed), or already emitted: no anchor.
    if (index === undefined || index < next) continue
    while (next <= index) merged.push(existing[next++]!)
  }
  while (next < existing.length) merged.push(existing[next++]!)
  return {
    entries: merged,
    appendedAfterWindow: false,
    // Observed, not inferred: whatever the rule above did, either the window's
    // first entry is still first or it is not.
    keptWindowHead: existing.length > 0 && merged[0] === existing[0],
  }
}

/**
 * Where in the window the next usable anchor sits, scanning forward from `from`.
 *
 * "Usable" means present in the window and not already emitted — the same two
 * conditions the anchor branch applies — so a fresh entry is never flushed
 * against an anchor the loop is going to skip.
 *
 * WHY the already-emitted half is load-bearing, though an earlier version of
 * this comment claimed it was mere symmetry (#1081 review, finding 3): a stale
 * index would indeed make the caller's flush loop a no-op — but skipping it
 * lets the scan CONTINUE to a later anchor that does flush. Same input,
 * different output:
 *
 *   window [b,a,x,c]  chunk [*a, f, *b, *c]
 *   with the guard: b,a,x,f,c        without it: b,a,f,x,c
 *
 * That window is out of durable order, which is the state this whole rule
 * exists to stop creating — but a pane can already be in it, because uuid
 * dedup made the old misorder permanent. Pinned by a test rather than left to
 * the claim.
 */
function nextAnchorIndex(
  placement: HistoryPlacement[],
  from: number,
  position: Map<string, number>,
  next: number,
): number | null {
  for (let at = from; at < placement.length; at += 1) {
    const item = placement[at]!
    if ('fresh' in item) continue
    const index = position.get(item.anchor)
    if (index === undefined || index < next) continue
    return index
  }
  return null
}

/**
 * Is `candidate` strictly newer than `reference`? False whenever either side
 * has no usable timestamp — an unknown order is not evidence of one, and the
 * callers all want the timestamp-free behaviour as their default.
 */
function isAfter(candidate: Entry | undefined, reference: Entry | undefined): boolean {
  const left = entryTime(candidate)
  const right = entryTime(reference)
  return left !== null && right !== null && left > right
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
  readHistory,
  preserveStatusUntilLoaded = false,
}: {
  sessionId: SessionId
  refs: WorkspaceRefs
  setRuntimes: WorkspaceSetRuntimes
  limit?: number
  meta?: SessionMeta
  // A scoped recovery can supply an owner/source-validated read while retaining
  // the existing mapper, UUID ledger, tool pairing and optimistic reconciliation.
  readHistory?: typeof window.api.loadInitialHistory
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
  // ── A LOAD BELONGS TO THE CONVERSATION IT STARTED ON (Astra review, #1) ──
  // A pane that follows its runtime into another provider session (Pi /new,
  // /resume, /fork) rebinds its identity and then resets its history window.
  // A load that started before either and resolves after would merge the OLD
  // conversation's rows into the new one's window (and View Prompts and the
  // orchestration reads would serve them). So capture both markers now and
  // refuse to apply a result, success or failure, once either moved.
  //
  // WHY the state's identity and not `meta`: a scoped recovery passes a meta
  // override naming the transcript to read, which need not equal the stored
  // one. What matters is only whether the pane's identity CHANGED while the
  // read was in flight. WHY the window generation too: the identity event can
  // land before the load starts (so both reads agree on the new id) while the
  // reset lands during it — and the generation is what the reset advances.
  const startedProviderSessionId = refs.stateRef.current.sessions[sessionId]?.providerSessionId
  const startedGeneration = refs.historyWindowsRef.current[sessionId]?.generation ?? null
  const superseded = (): boolean =>
    (refs.historyWindowsRef.current[sessionId]?.generation ?? null) !== startedGeneration ||
    refs.stateRef.current.sessions[sessionId]?.providerSessionId !== startedProviderSessionId
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
    // WHY an async wrapper instead of `.finally()` on the IPC promise: if the
    // bridge call throws before returning a promise (a missing or broken
    // `window.api` method), `.finally` is never attached and the slot is
    // never released. With two module-level slots, two such throws stall
    // every later history load in the window, and nothing reports it. The
    // slot still frees as soon as the history read settles, not after
    // `gitWorktrees`.
    const historyRead = (async () => {
      try {
        return await (readHistory ?? window.api.loadInitialHistory)({
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
        : { entries: current.entries, appendedAfterWindow: false, keptWindowHead: current.entries.length > 0 }
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
