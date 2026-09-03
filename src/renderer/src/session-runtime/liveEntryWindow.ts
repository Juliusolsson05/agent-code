import { isConversationEntry } from '@shared/types/transcript'
import type { Entry } from '@shared/types/transcript'
import type { GhostEntry } from 'agent-transcript-parser/ghost'
import { isGhostHiddenBehindJsonlTail } from '@renderer/session-runtime/ghosts'

import type { SemanticRuntimeState } from '@renderer/session-runtime/state'

// -----------------------------------------------------------------------------
// liveEntryWindow — the live transcript window (issue #375).
//
// `runtime.entries` used to be bounded only at bootstrap (initial history
// loads 120, older pages 200) and then grew WITHOUT LIMIT on the live path:
// every jsonl burst did `[...baseEntries, ...appended]` forever. A day-long
// agent session accumulates tens of thousands of entries — each carrying full
// tool_result payloads — and the renderer's heap grows monotonically until
// the window is closed. This module owns the policy and bookkeeping for
// trimming the OLDEST live entries back out of memory while keeping them
// reloadable through the existing older-history pagination path.
//
// The DESIGN INVARIANT that makes trimming safe at all: `totalEntries` is the
// on-disk denominator and was always documented as independent of the
// `entries` window ("entries is the lazy-load window", state.ts). Trimming
// therefore NEVER touches totalEntries — it only narrows the in-memory
// window, exactly like never having paged those entries in.
//
// Everything here is deliberately renderer-module state (not SessionRuntime
// fields): the marker riders and trimmed-uuid sets are ingestion bookkeeping
// the same way `seenUuidsRef` and `codexCurrentTurnIdBySession` are. Rendering
// must never react to them directly — the only render-visible effect of a
// trim is the new (smaller) entries array reference.
// -----------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Window sizing
// ---------------------------------------------------------------------------

/** Trim triggers when the live entries array exceeds this. 2000 is
 *  deliberately GENEROUS — an order of magnitude above the bootstrap
 *  window (120) and comfortably above anything a user actually scrolls
 *  through live. The point of the window is to bound the pathological
 *  day-long-session case, not to aggressively minimize memory; a
 *  too-tight cap would make the safety constraints below (live-turn
 *  ownership, ghost supersede evidence) bite constantly and turn every
 *  burst into a trim decision. */
export const MAX_LIVE_ENTRIES = 2000

/** When a trim fires, cut down to this many retained entries. Trimming
 *  to a target BELOW the trigger (hysteresis) means we trim in chunks
 *  of ~500 instead of shaving one entry per burst — the index rebuild
 *  and ledger recompute cost is paid once per ~500 appends instead of
 *  on every append past the cap. */
export const TRIM_TO_LIVE_ENTRIES = 1500

/** Byte budget — the OTHER trim trigger. #375 is fundamentally a BYTES
 *  problem, not an entry-count problem: 2000 chat-sized entries are a
 *  couple of MB and harmless, while a few hundred entries each dragging
 *  a multi-hundred-KB tool_result (build logs, file reads, agent output
 *  dumps) blow past that long before the count cap fires. A count-only
 *  window would leave exactly the pathological sessions the window
 *  exists for unbounded. 32 MiB is deliberately generous for the same
 *  reason MAX_LIVE_ENTRIES is: the point is to bound the pathological
 *  case, not to squeeze memory — and estimates are JSON.stringify
 *  string lengths (see estimateEntryBytes), i.e. order-of-magnitude
 *  truth, so the cap must have headroom for estimator error. */
export const MAX_LIVE_ENTRY_BYTES = 32 * 1024 * 1024

/** Byte-trim hysteresis target, mirroring TRIM_TO_LIVE_ENTRIES: cut to
 *  ~24 MiB so byte-driven trims also happen in chunks, not one giant
 *  entry per burst. Both budgets are targets, not guarantees — the
 *  safety constraints in planLiveEntryTrim (live-turn ownership, ghost
 *  evidence, pair integrity, marker anchoring) always win, and when
 *  they forbid reaching the target we trim what's allowed and stop. */
export const TRIM_TO_LIVE_ENTRY_BYTES = 24 * 1024 * 1024

/** How long after an older-history prepend trimming stays suspended.
 *
 *  WHY: Feed has no shrink-anchoring — removing rows above the viewport
 *  shifts scroll position. A user who just paged older history in is by
 *  definition reading near the TOP of the window, i.e. exactly the rows
 *  a trim would remove. `loadingOlderHistory` only covers the in-flight
 *  fetch; this grace window covers the reading that follows. 30s errs
 *  toward not trimming: the window is a memory bound, not a hard
 *  invariant, and the first burst after the grace elapses will trim. */
export const OLDER_PREPEND_TRIM_GRACE_MS = 30_000

// ---------------------------------------------------------------------------
// History-marker rider
// ---------------------------------------------------------------------------
//
// Constraint: pagination must be able to RELOAD trimmed entries. The older-
// history loader fetches strictly BEFORE `historyOldestMarker`, so on trim we
// must advance that marker to the oldest RETAINED entry's provider marker —
// which means every entry needs to remember the `historyMarker` its raw line
// produced at map time.
//
// WHY a non-enumerable symbol rider on the Entry object instead of a parallel
// per-session uuid→marker Map: a Map would be yet another never-shrinking
// per-session structure (the exact pathology this PR instruments), needing
// its own lifecycle plumbing at all six seenUuids teardown sites. A rider
// dies with the entry — memory is proportional to the live window by
// construction. Symbol-keyed + non-enumerable makes it invisible to
// JSON.stringify (debug bundles, byte-estimate sampling), object spreads of
// entry CONTENTS, and structuredClone consumers; anything that copies the
// entry object wholesale keeps the rider, anything that re-shapes it drops
// it, and `historyMarkerOf` treats "no rider" as "unknown" (which blocks
// trimming past that entry rather than corrupting pagination).

const HISTORY_MARKER_RIDER = Symbol('agentCode.historyMarker')

type EntryWithMarkerRider = Entry & { [HISTORY_MARKER_RIDER]?: string }

/** Stamp the provider pagination marker of the raw line this entry was
 *  mapped from. Called at all three ingest sites (live burst, initial
 *  history, older history) right after the mapper returns. No-op for a
 *  null marker (Claude non-conversation lines) — those entries simply
 *  can't anchor pagination and the trimmer stops before them. */
export function stampHistoryMarker(entry: Entry, marker: string | null): void {
  if (!marker) return
  // defineProperty (not plain assignment) so the property is
  // non-enumerable; writable+configurable so a re-mapped duplicate line
  // can re-stamp without throwing.
  Object.defineProperty(entry, HISTORY_MARKER_RIDER, {
    value: marker,
    enumerable: false,
    writable: true,
    configurable: true,
  })
}

export function historyMarkerOf(entry: Entry): string | null {
  const marker = (entry as EntryWithMarkerRider)[HISTORY_MARKER_RIDER]
  return typeof marker === 'string' ? marker : null
}

// ---------------------------------------------------------------------------
// Trimmed-uuid bookkeeping (the asymmetric dedupe)
// ---------------------------------------------------------------------------
//
// `seenUuidsRef` keeps every uuid a session has ever ingested so replayed
// bursts (resume bootstrapTail, duplicate deliveries) are dropped. A trimmed
// entry's uuid must STAY "seen" on the live path — a resume replay of old
// rows must not re-append day-old entries at the TAIL of the feed. But the
// older-history path must be allowed to bring exactly those uuids back (in
// order, at the head). Hence the asymmetry:
//
//   live ingest    : blocked by  seen ∪ trimmed   (seen already contains
//                    trimmed uuids — they were seen once — so the live path
//                    needs no change; the set below is belt-and-braces for
//                    the seen-reset lifecycle described next)
//   older history  : trimmed membership OVERRIDES seen — the uuid loads,
//                    and is removed from the trimmed set (it's back in the
//                    window and will re-enter the trim cycle normally).
//
// Lifecycle: cleared wherever `seenUuidsRef.current[sessionId]` is deleted or
// reset (pane close, kill, rename, restart-in-place, tab close). Keeping the
// two sets on the same lifecycle preserves the invariant trimmed ⊆ ever-seen;
// letting trimmed outlive a seen reset would make a freshly restarted session
// silently drop rows its new seen set has never met.

const trimmedUuidsBySession = new Map<string, Set<string>>()

export function markUuidsTrimmed(sessionId: string, uuids: readonly string[]): void {
  let set = trimmedUuidsBySession.get(sessionId)
  if (!set) {
    set = new Set()
    trimmedUuidsBySession.set(sessionId, set)
  }
  for (const uuid of uuids) set.add(uuid)
}

export function isUuidTrimmed(sessionId: string, uuid: string): boolean {
  return trimmedUuidsBySession.get(sessionId)?.has(uuid) ?? false
}

/** Older-history reload path: the uuid is back in the window. */
export function releaseTrimmedUuid(sessionId: string, uuid: string): void {
  const set = trimmedUuidsBySession.get(sessionId)
  if (!set) return
  set.delete(uuid)
  if (set.size === 0) trimmedUuidsBySession.delete(sessionId)
}

/** For the memory gauges — how many uuids this session has trimmed and
 *  not yet reloaded. */
export function trimmedUuidCount(sessionId: string): number {
  return trimmedUuidsBySession.get(sessionId)?.size ?? 0
}

// ---------------------------------------------------------------------------
// Older-prepend grace tracking
// ---------------------------------------------------------------------------

const lastOlderPrependAtBySession = new Map<string, number>()

/** Called by the older-history loader whenever it actually prepended
 *  entries. Suspends trimming for OLDER_PREPEND_TRIM_GRACE_MS. */
export function noteOlderHistoryPrepend(sessionId: string, now = Date.now()): void {
  lastOlderPrependAtBySession.set(sessionId, now)
}

export function withinOlderPrependGrace(sessionId: string, now = Date.now()): boolean {
  const at = lastOlderPrependAtBySession.get(sessionId)
  return at !== undefined && now - at < OLDER_PREPEND_TRIM_GRACE_MS
}

/** Session teardown — called at the same sites that delete/reset the
 *  session's seenUuids set (see the lifecycle note above). */
export function clearLiveEntryWindowSession(sessionId: string): void {
  trimmedUuidsBySession.delete(sessionId)
  lastOlderPrependAtBySession.delete(sessionId)
}

// ---------------------------------------------------------------------------
// Byte accounting
// ---------------------------------------------------------------------------

/** JSON.stringify length of one value — the byte-estimate primitive shared
 *  with the perf memory gauges (performance/memoryInstrumentation.ts imports
 *  it; it lives HERE and not there because that module already imports this
 *  one for trimmedUuidCount, and the reverse import would be a cycle).
 *  string.length undercounts multi-byte UTF-8 but is allocation-free compared
 *  to TextEncoder; both the gauges and the trim budget only need
 *  order-of-magnitude fidelity. Never throws — a byte estimate must not be
 *  able to take down ingest, so circular/unstringifiable values count as 0. */
export function estimateJsonBytes(item: unknown): number {
  try {
    return JSON.stringify(item)?.length ?? 0
  } catch {
    return 0
  }
}

/** Per-entry byte estimates, cached for the lifetime of the entry OBJECT.
 *
 *  WHY a WeakMap and not ingest-time accounting on runtime state: an exact
 *  running total would need decrement bookkeeping at every trim / reload /
 *  optimistic-reconcile site to stay honest — a whole class of drift bugs
 *  for what is a budget heuristic (memoryInstrumentation.ts makes the same
 *  argument for its gauges). The WeakMap has no decrement problem at all:
 *  GC owns eviction, so memory is proportional to live entries by
 *  construction, exactly like the marker rider above.
 *
 *  WHY caching is sound: entries are immutable after mapping — updated tool
 *  results arrive as NEW entry objects (see indexEntryIntoMaps' re-point
 *  semantics), never as in-place mutation of an ingested entry. The symbol
 *  marker rider is non-enumerable, so it never perturbs the estimate.
 *
 *  Cost shape: each entry is stringified exactly ONCE in its lifetime
 *  (O(appended) per burst), and the per-burst budget check is a cache-hit
 *  sum — cheaper in aggregate than re-sampling the window per burst would
 *  be, and unlike sampling it can't be fooled by a skewed size mix. */
const entryBytesCache = new WeakMap<Entry, number>()

export function estimateEntryBytes(entry: Entry): number {
  let bytes = entryBytesCache.get(entry)
  if (bytes === undefined) {
    bytes = estimateJsonBytes(entry)
    entryBytesCache.set(entry, bytes)
  }
  return bytes
}

export function estimateLiveEntriesBytes(entries: readonly Entry[]): number {
  let total = 0
  for (const entry of entries) total += estimateEntryBytes(entry)
  return total
}

/** Cheap per-burst gate for the ingest path: should the planner even run?
 *  Count check first (free), byte sum second (cache-hit WeakMap walk).
 *  Callers keep their own cheaper guards (older-history grace, in-flight
 *  pagination) in front of this. */
export function liveEntryWindowOverBudget(entries: readonly Entry[]): boolean {
  if (entries.length > MAX_LIVE_ENTRIES) return true
  return estimateLiveEntriesBytes(entries) > MAX_LIVE_ENTRY_BYTES
}

// ---------------------------------------------------------------------------
// The trim planner
// ---------------------------------------------------------------------------

/** Shared optimistic-row uuid marker (see collectLedgerInput.ts, which
 *  partitions on the same prefix; addOptimisticCodexUserEntry mints it
 *  for every optimistic-echo provider, not just codex). Duplicated as a
 *  literal because session-runtime must not import providers/renderer
 *  modules — the prefix IS the cross-layer contract. */
const OPTIMISTIC_UUID_PREFIX = 'optimistic-codex-user:'

export type LiveEntryTrimPlan = {
  /** Drop entries[0..cut). Always > 0 when a plan is returned. */
  cut: number
  /** uuids of the dropped entries, for markUuidsTrimmed. */
  trimmedUuids: string[]
  /** Pagination marker of the oldest RETAINED entry — the new
   *  historyOldestMarker, so loadOlderHistory can fetch the trimmed
   *  region back ("strictly before marker" semantics). */
  nextOldestMarker: string
  /** The computed protection bound, surfaced for the feed-debug record. */
  protectBeforeMs: number
  /** Estimated bytes of the FULL pre-trim window and of the retained
   *  slice, surfaced for the feed-debug record so a bundle grep can tell
   *  a count-triggered trim from a byte-triggered one and see how close
   *  the safety constraints let us get to the byte target. */
  preTrimBytesEstimate: number
  retainedBytesEstimate: number
}

/** Content blocks of a conversation entry, or [] for shapes the tool-pair
 *  scan can't (and needn't) see inside. Mirrors indexEntryIntoMaps'
 *  reading of `message.content` — the two MUST agree on what counts as a
 *  tool block, because constraint 5 below exists precisely to keep the
 *  maps that indexEntryIntoMaps builds pair-complete after a trim. */
function contentBlocksOf(entry: Entry): readonly Record<string, unknown>[] {
  if (!isConversationEntry(entry)) return []
  const content = entry.message.content
  return Array.isArray(content) ? (content as Record<string, unknown>[]) : []
}

function entryTimestampMs(entry: Entry): number | null {
  const ts = (entry as { timestamp?: unknown }).timestamp
  if (typeof ts !== 'string') return null
  const ms = Date.parse(ts)
  return Number.isFinite(ms) ? ms : null
}

/** Everything at-or-after this wall-clock instant must stay in the window.
 *
 *  WHY these three sources (the #165/#191/#344 regression class):
 *  committed-ownership suppression (rendering/model/ownership.ts,
 *  observations/committed.ts) decides whether a LIVE turn's semantic
 *  blocks / ghosts paint by checking whether a committed entry already
 *  owns the same message id / tool_use id / text. If we trimmed the
 *  committed owner of a turn that is still represented on the semantic-
 *  history plane or in an un-superseded ghost, the live copy would lose
 *  its owner and RE-PAINT as a duplicate row. So the trim boundary must
 *  stay strictly OLDER than:
 *    - the oldest semantic.history turn's startedAt (history turns are
 *      paint inputs until their committed owners suppress them),
 *    - the current turn's startedAt (same argument, more acute),
 *    - every un-superseded ghost's updatedAt (a superseded ghost's
 *      owner is safe to trim — the ghost is already scheduled for GC).
 *  Entry timestamps are producer wall-clock (ISO strings) and these
 *  bounds are renderer wall-clock (Date.now() at fold time); comparing
 *  the two is the established convention of this codebase
 *  (lastJsonlEntryAt vs ghost updatedAt — see state.ts). */
function computeProtectBound(
  semantic: SemanticRuntimeState,
  ghosts: ReadonlyMap<string, GhostEntry>,
  lastJsonlEntryAt: number | null,
): number {
  let bound = Infinity
  for (const turn of semantic.history) {
    if (turn.startedAt < bound) bound = turn.startedAt
  }
  if (semantic.currentTurn && semantic.currentTurn.startedAt < bound) {
    bound = semantic.currentTurn.startedAt
  }
  for (const ghost of ghosts.values()) {
    if (ghost._atp.supersededBy !== undefined) continue
    // An orphan the committed tail has already passed can never paint again
    // (render predicate rule 4 — see isGhostHiddenBehindJsonlTail in
    // ghosts.ts, where the sweep uses the same test), so it has no claim on
    // the window. Without this, one never-matched orphan pinned the bound
    // for the rest of the session and the window became append-only (#724).
    if (isGhostHiddenBehindJsonlTail(ghost, lastJsonlEntryAt)) continue
    if (ghost._atp.updatedAt < bound) bound = ghost._atp.updatedAt
  }
  return bound
}


/**
 * Decide how much of the head of `entries` can be dropped. Returns null when
 * nothing can (or should) be trimmed. Pure — the caller applies the plan.
 *
 * Safety constraints, in the order they gate:
 *
 * 1. UUID-LESS ENTRIES FREEZE THE WINDOW. Two reasons, both hard:
 *    (a) reload-dedupe — a trimmed entry comes back through older-history
 *        pagination, whose dedupe is uuid-based; a uuid-less entry would
 *        re-prepend as a duplicate row on every reload.
 *    (b) ingest-index identity — the ledger's committed collector keys
 *        uuid-less entries as `entry:ingest-${index}` (committed.ts), which
 *        is only stable because indices never shift. A front-trim shifts
 *        every retained index; a retained uuid-less entry would collide
 *        with an id previously owned by a DIFFERENT entry — the exact
 *        "phantom duplicate" React-key class that id scheme exists to
 *        prevent. In practice every mapped entry carries a uuid (Claude
 *        lines have them; Codex/opencode mappers synthesize them), so this
 *        guard is a freeze-don't-corrupt failsafe, not an expected path.
 *
 * 2. Optimistic rows are never trimmed (they live at the tail by
 *    construction, so hitting one this early means something is wrong —
 *    stop rather than guess).
 *
 * 3. The protection bound (computeProtectBound above): stop at the first
 *    entry at-or-newer than the bound, or with an unparseable timestamp
 *    while a finite bound is active (can't prove it's older → keep it).
 *
 * 4. The oldest retained entry must yield a pagination marker, or the trim
 *    is aborted — advancing historyOldestMarker is what keeps the trimmed
 *    region reachable, and a trim that can't advance it would strand those
 *    entries permanently.
 *
 * 5. THE BOUNDARY MUST NOT SPLIT A CROSS-ENTRY TOOL PAIR. tool_use and its
 *    tool_result live in DIFFERENT entries (assistant entry carries the
 *    use, the following user entry carries the result — on every
 *    provider), and the ingest path rebuilds toolUseIndex/toolResultIndex
 *    from RETAINED entries only after applying a plan. If the cut landed
 *    between a pair, the retained result would lose its source-tool
 *    metadata: ToolResultRow resolves its command/file/args through
 *    toolUseIndex, so Read/Edit/TodoWrite/git/AskUserQuestion rich
 *    rendering and result suppression would silently degrade for that row
 *    — permanently, since no later burst re-delivers the trimmed use. The
 *    fix direction is always to RETAIN MORE (pull the boundary older until
 *    no retained result references a trimmed use), never to trim the
 *    result too: the result may be inside the protected region. Applied to
 *    a fixpoint because retaining an entry can expose ITS result blocks
 *    referencing still-older uses (each region is scanned once, so the
 *    whole pass stays O(window)). The reverse split — use retained, result
 *    trimmed — cannot happen: results always come later in the array than
 *    their use, and trims only take the head.
 */
export function planLiveEntryTrim(
  entries: readonly Entry[],
  semantic: SemanticRuntimeState,
  ghosts: ReadonlyMap<string, GhostEntry>,
  // The committed JSONL tail, so orphan ghosts already hidden behind it stop
  // pinning the bound (see isGhostHiddenBehindJsonlTail). Null keeps every
  // un-superseded ghost protective, which is the pre-#724 behaviour.
  lastJsonlEntryAt: number | null = null,
): LiveEntryTrimPlan | null {
  // Either budget can trigger (#375 is a bytes problem — see the constant
  // docs). The byte sum is a WeakMap cache-hit walk, so evaluating it on
  // every planner call is cheap; callers additionally pre-gate with
  // liveEntryWindowOverBudget.
  const preTrimBytesEstimate = estimateLiveEntriesBytes(entries)
  const overCount = entries.length > MAX_LIVE_ENTRIES
  const overBytes = preTrimBytesEstimate > MAX_LIVE_ENTRY_BYTES
  if (!overCount && !overBytes) return null

  // Desired cut = whichever budget asks for MORE. The byte walk stops at
  // entries.length - 1 (never propose trimming the final entry): there is
  // deliberately NO larger retained-count floor for byte trims, because any
  // floor re-opens exactly the unbounded-bytes hole the cap closes (a few
  // hundred multi-MB entries would ride under it forever). If a byte trim
  // would cut into live/visible content, constraints 2-3 below stop it —
  // the protection bound, not an arbitrary count, is the real floor.
  const cutForCount = overCount ? entries.length - TRIM_TO_LIVE_ENTRIES : 0
  let cutForBytes = 0
  if (overBytes) {
    let retainedBytes = preTrimBytesEstimate
    while (
      cutForBytes < entries.length - 1 &&
      retainedBytes > TRIM_TO_LIVE_ENTRY_BYTES
    ) {
      retainedBytes -= estimateEntryBytes(entries[cutForBytes])
      cutForBytes += 1
    }
  }
  const desiredCut = Math.max(cutForCount, cutForBytes)
  if (desiredCut === 0) return null

  // Constraint 1: any uuid-less entry anywhere freezes the window.
  for (const entry of entries) {
    const uuid = (entry as { uuid?: unknown }).uuid
    if (typeof uuid !== 'string' || uuid.length === 0) return null
  }

  const protectBeforeMs = computeProtectBound(semantic, ghosts, lastJsonlEntryAt)

  let cut = 0
  const trimmedUuids: string[] = []
  for (let i = 0; i < desiredCut; i++) {
    const entry = entries[i]
    const uuid = (entry as { uuid: string }).uuid
    // Constraint 2.
    if (uuid.startsWith(OPTIMISTIC_UUID_PREFIX)) break
    // Constraint 3. When no live turn / history / ghost exists the bound
    // is Infinity and the timestamp check is skipped entirely — entries
    // without timestamps (rare non-conversation shapes) shouldn't freeze
    // a window that has nothing live to protect.
    if (Number.isFinite(protectBeforeMs)) {
      const ts = entryTimestampMs(entry)
      if (ts === null || ts >= protectBeforeMs) break
    }
    trimmedUuids.push(uuid)
    cut = i + 1
  }
  if (cut === 0) return null

  // Constraint 5: pair integrity (see the doc block above). Index the
  // tool_use ids of the would-be-trimmed region, then pull the boundary
  // older until no retained tool_result references a trimmed tool_use.
  // Fixpoint via non-overlapping region scans: pass 1 scans the retained
  // window [cut, end); each later pass scans only the region the previous
  // pass newly retained — every index is visited at most once, O(window).
  const trimmedToolUseEntryIndex = new Map<string, number>()
  for (let i = 0; i < cut; i++) {
    for (const block of contentBlocksOf(entries[i])) {
      if (block.type === 'tool_use' && typeof block.id === 'string') {
        trimmedToolUseEntryIndex.set(block.id, i)
      }
    }
  }
  if (trimmedToolUseEntryIndex.size > 0) {
    let boundary = cut
    let scanFrom = cut
    let scanTo = entries.length
    for (;;) {
      let required = boundary
      for (let i = scanFrom; i < scanTo; i++) {
        for (const block of contentBlocksOf(entries[i])) {
          if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') {
            continue
          }
          const useEntryIndex = trimmedToolUseEntryIndex.get(block.tool_use_id)
          // `< required` (the running minimum), not `< boundary`: a use
          // that an earlier block in this same pass already pulled into
          // the retained region needs no further action.
          if (useEntryIndex !== undefined && useEntryIndex < required) {
            required = useEntryIndex
          }
        }
      }
      if (required === boundary) break
      scanTo = boundary
      scanFrom = required
      boundary = required
    }
    if (boundary < cut) {
      cut = boundary
      // trimmedUuids[i] is entries[i]'s uuid by construction of the
      // constraint loop above, so tightening the boundary is a truncate.
      trimmedUuids.length = boundary
    }
  }
  if (cut === 0) return null

  // Constraint 4: find the oldest retained marker (skip forward past
  // retained entries whose raw line had none — pagination will re-read a
  // few filtered lines in that case, which the loader's mapper drops
  // again; same tolerance the marker-policy comments already document).
  let nextOldestMarker: string | null = null
  for (let i = cut; i < entries.length; i++) {
    const marker = historyMarkerOf(entries[i])
    if (marker) {
      nextOldestMarker = marker
      break
    }
  }
  if (!nextOldestMarker) return null

  // Cache-hit walk of the final trimmed slice — the constraint loops above
  // may have stopped short of desiredCut, so this can't be accumulated
  // inline without re-deriving it on every early break.
  let trimmedBytesEstimate = 0
  for (let i = 0; i < cut; i++) trimmedBytesEstimate += estimateEntryBytes(entries[i])

  return {
    cut,
    trimmedUuids,
    nextOldestMarker,
    protectBeforeMs,
    preTrimBytesEstimate,
    retainedBytesEstimate: preTrimBytesEstimate - trimmedBytesEstimate,
  }
}
