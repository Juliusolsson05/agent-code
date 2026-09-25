import type { Entry, ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'
import { indexEntryIntoMaps } from '@renderer/session-runtime/entries'
import { stampHistoryMarker } from '@renderer/session-runtime/liveEntryWindow'
import type { HistoryPlacement } from '@renderer/session-runtime/ingest/historyPlacement'

// The committed-transcript admission rules every ingest site shares (#1177).
//
// WHY this module exists. Four loops turned mapped transcript records into
// feed entries: the desktop's live JSONL burst (useIpcSubscriptions Pass B),
// its initial-history loader, its older-history pager, and the phone's
// TranscriptStore. Each one re-typed the same four rules — dedupe against the
// seen ledger, respect the live window's trimmed tombstones, stamp the
// pagination marker, fold tool blocks into the pairing indexes — and the
// copies had already drifted: the phone's initial load re-admitted trimmed
// ids the desktop treats as seen, its older pages rebuilt the tool indexes
// while the desktop's only appended to them, and its "first kept line" was a
// comment rather than the code. A rule now lives here once and every site
// calls it.
//
// What deliberately does NOT live here: anything only one client has. The
// desktop's Claude queue attribution, optimistic-row reconciliation, worktree
// evidence and ghost reconciliation interleave with these rules inside its
// loops and stay there, because the phone has none of those planes and a
// shared core that carried them would make it hold state it can never fill.
// So this is a set of per-record steps a loop calls, not a loop that owns
// the caller's burst.

/**
 * How a batch relates to the window it lands in. The dedupe rule differs,
 * and the difference is load-bearing (#375 part B):
 *
 * - `live`: a burst at the TAIL. A uuid the live window trimmed is still
 *   "seen" — a resume replay must never re-append trimmed old rows below the
 *   newest ones.
 * - `tail`: the initial newest-N history chunk. Same rule as live, for the
 *   same reason: it is the newest slice of the transcript, so a trimmed uuid
 *   showing up means the window already trimmed past it. Its already-held
 *   uuids become placement ANCHORS (see historyPlacement.ts).
 * - `older`: a page strictly before the window's oldest marker. This is the
 *   ONLY way trimmed entries come back, in order, at the head — so trimmed
 *   membership overrides `seen`, and the id leaves the tombstone set as it
 *   reloads and re-enters the trim cycle normally.
 */
export type CommittedAdmissionMode = 'live' | 'tail' | 'older'

/**
 * The per-session dedupe ledger. An interface rather than a Set pair because
 * the two clients store tombstones differently: the desktop keeps them in a
 * module registry keyed by session (liveEntryWindow.ts) that its trim and
 * pager share, the phone keeps a Set on its per-session state that dies with
 * the view. The RULE is the same; only the storage is the caller's.
 */
export type CommittedSeenLedger = {
  seen: Set<string>
  isTrimmed(uuid: string): boolean
  releaseTrimmed(uuid: string): void
}

export type ToolIndexes = {
  toolUseIndex: Map<string, ToolUseBlock>
  toolResultIndex: Map<string, ToolResultBlock>
}

export type AdmittedEntries = {
  /** Entries this record contributes to the window, in record order. */
  admitted: Entry[]
  /** True when any tool_use/tool_result key was inserted or re-pointed.
   *  Always false when no `indexes` were passed. */
  toolIndexChanged: boolean
}

/**
 * Admit ONE raw record's mapped entries under `mode`'s dedupe rule.
 *
 * `marker` is the record's own pagination marker (the mapper's
 * `historyMarker`); it is stamped onto every admitted entry so a later trim
 * can re-anchor the window's oldest marker at whatever entry ends up
 * oldest-retained (liveEntryWindow.ts).
 *
 * `indexes`, when passed, are folded IN PLACE as entries are admitted. Only
 * the LIVE site passes them: a live burst is the newest rows, so admission
 * order is window order. History sites pass none and reindex the merged
 * window once afterwards (see reindexToolsAfterMerge).
 *
 * `placement`, when passed (`tail` only), receives the record's entries in
 * durable order — fresh ones and anchors for ids the window already holds.
 */
export function admitMappedEntries(
  mapped: readonly Entry[],
  marker: string | null,
  mode: CommittedAdmissionMode,
  ledger: CommittedSeenLedger,
  options: { indexes?: ToolIndexes; placement?: HistoryPlacement[] } = {},
): AdmittedEntries {
  const admitted: Entry[] = []
  let toolIndexChanged = false
  for (const entry of mapped) {
    // Truthiness, as every site had it: an empty-string uuid is no identity
    // and must not dedupe against another empty one.
    const raw = (entry as { uuid?: unknown }).uuid
    const uuid = typeof raw === 'string' && raw.length > 0 ? raw : null
    if (uuid) {
      const trimmed = ledger.isTrimmed(uuid)
      const duplicate = mode === 'older'
        ? ledger.seen.has(uuid) && !trimmed
        : ledger.seen.has(uuid) || trimmed
      if (duplicate) {
        options.placement?.push({ anchor: uuid })
        continue
      }
      ledger.seen.add(uuid)
      if (mode === 'older') ledger.releaseTrimmed(uuid)
    }
    stampHistoryMarker(entry, marker)
    admitted.push(entry)
    options.placement?.push({ fresh: entry })
    if (options.indexes && indexEntryIntoMaps(entry, options.indexes.toolUseIndex, options.indexes.toolResultIndex)) {
      toolIndexChanged = true
    }
  }
  return { admitted, toolIndexChanged }
}

/**
 * Is this record a candidate pagination anchor? The rule every site uses:
 * the FIRST raw record that mapped to at least one entry AND carries a
 * marker. Deliberately evaluated on MAPPED output, before dedupe — records
 * the mapper drops (Codex turn_context, Claude snapshots) must not become
 * the cursor, or the loader's marker-at-offset check fails and every older
 * page degrades to the slow scan; a record whose entries are all duplicates
 * is still a real line of the transcript at that position. Each site keeps
 * its own latch (first-in-burst, first-in-chunk, or only-when-unset),
 * because WHEN the cursor may move is the site's decision.
 */
export function isPaginationAnchor(mapped: readonly Entry[], marker: string | null): marker is string {
  return mapped.length > 0 && typeof marker === 'string' && marker.length > 0
}

/**
 * The newest producer timestamp among `entries`, never lower than `previous`.
 *
 * WHY producer time and not Date.now(): selectMergedEntries compares it with
 * ghost `_atp.updatedAt`, and the ownership ledger's collapsed-running rule
 * compares it with the live turn — both are "when the producer observed
 * this", so a resumed session compares yesterday against yesterday. Entries
 * without a usable `timestamp` (compact boundaries, queue ops) leave the
 * cursor where it was: they are not evidence the committed channel is alive.
 *
 * Shared since #1177: the phone used to hand the ledger a constant 0, so the
 * collapsed-running rule could never fire there (ARCHITECTURE §8.3).
 */
export function latestCommittedTimestamp(previous: number | null, entries: readonly Entry[]): number | null {
  let latest = previous
  for (const entry of entries) {
    const ts = (entry as { timestamp?: unknown }).timestamp
    if (typeof ts !== 'string') continue
    const ms = Date.parse(ts)
    if (!Number.isFinite(ms)) continue
    if (latest === null || ms > latest) latest = ms
  }
  return latest
}

/**
 * Fold a HISTORY batch's tool blocks into the window's pairing indexes, IN
 * PLACE. `window` is the merged result, with `batch` already placed in it
 * (prepended for an older page, placed by the #910 rule for the initial
 * chunk). Returns true when the batch carried any tool block (the caller
 * bumps toolIndexVersion); a batch without one leaves the maps untouched and
 * reports false, so paging through prose never invalidates memoized rows.
 *
 * WHY a rebuild in window order instead of indexing the batch's blocks as
 * they are admitted: history lands BEHIND (or among) entries the window
 * already indexed, so indexing it afterwards lets an OLDER block overwrite a
 * newer one whenever an id repeats — a reloaded trimmed region, or a provider
 * that re-emits a tool id across a resume. The desktop indexed history in
 * place on the argument that ids are unique within a session; the phone
 * rebuilt. The rebuild is correct in both cases and identical whenever ids
 * ARE unique, so both clients now rebuild (#1177). The maps are cleared and
 * refilled rather than replaced because Feed's contexts hold these exact
 * references. Live bursts keep indexing in place: they are the newest rows,
 * so in-place order IS window order there.
 */
export function reindexToolsAfterMerge(
  batch: readonly Entry[],
  window: readonly Entry[],
  indexes: ToolIndexes,
): boolean {
  // Scratch maps answer "did this batch carry a tool block" without touching
  // the live ones; the same predicate the in-place path uses.
  const scratchUse = new Map<string, ToolUseBlock>()
  const scratchResult = new Map<string, ToolResultBlock>()
  let carriesTools = false
  for (const entry of batch) {
    if (indexEntryIntoMaps(entry, scratchUse, scratchResult)) carriesTools = true
  }
  if (!carriesTools) return false
  indexes.toolUseIndex.clear()
  indexes.toolResultIndex.clear()
  for (const entry of window) indexEntryIntoMaps(entry, indexes.toolUseIndex, indexes.toolResultIndex)
  return true
}
