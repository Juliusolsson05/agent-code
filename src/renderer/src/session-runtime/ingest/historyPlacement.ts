import type { Entry } from '@shared/types/transcript'

// Where a history chunk's new entries go relative to the entries a view
// already holds (#910). Moved here from the desktop's initialHistory.ts in
// #1177 so the phone's backfill runs the SAME placement rule: the phone used
// to prepend every chunk blindly, which is exactly the permanent misorder
// this rule was written to end (newer turns above older ones once a live
// burst or a stopped reader put the view ahead of the durable read). The
// rule is a pure function of a chunk and a window, so both clients can share
// it without sharing any state.

// A history chunk in its own (durable) order: entries the pane does not have
// yet, and uuids of entries it already holds, which act as anchors.
export type HistoryPlacement = { fresh: Entry } | { anchor: string }

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
 *
 * Callers: the two INITIAL-history loaders (desktop initialHistory.ts, phone
 * TranscriptStore.loadInitialHistory). Older-page pagination does not use it:
 * a page read strictly before the window's oldest marker is older than
 * everything the window holds by construction, so a plain prepend is exact.
 *
 * Tests call it directly rather than through a loader, which the cursor half
 * of #910 does successfully: this rule's inputs are a chunk/window
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
 * pagination cursor needs — see its use in the desktop loader.
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
