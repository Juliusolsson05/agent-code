import type { Entry } from '@shared/types/transcript'
import type { GhostEntry } from 'agent-transcript-parser/ghost'

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
 */
export function planLiveEntryTrim(
  entries: readonly Entry[],
  semantic: SemanticRuntimeState,
  ghosts: ReadonlyMap<string, GhostEntry>,
): LiveEntryTrimPlan | null {
  if (entries.length <= MAX_LIVE_ENTRIES) return null
  const desiredCut = entries.length - TRIM_TO_LIVE_ENTRIES

  // Constraint 1: any uuid-less entry anywhere freezes the window.
  for (const entry of entries) {
    const uuid = (entry as { uuid?: unknown }).uuid
    if (typeof uuid !== 'string' || uuid.length === 0) return null
  }

  const protectBeforeMs = computeProtectBound(semantic, ghosts)

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

  return { cut, trimmedUuids, nextOldestMarker, protectBeforeMs }
}
