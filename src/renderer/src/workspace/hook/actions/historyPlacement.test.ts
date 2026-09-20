import { describe, expect, it } from 'vitest'

import { placeHistoryEntries } from './initialHistory'

// ---------------------------------------------------------------------------
// #910 item 2. A pane holds [a,c]. A history chunk arrives as [b,c], with
// a < b < c. The merger pushed fresh `b` immediately and only then flushed the
// window through anchor `c`, producing [b,a,c] — and uuid dedup makes that
// order permanent.
//
// Nothing errors. The conversation simply renders in the wrong order and the
// user has no way to tell, which is why this is worth a regression rather than
// a comment.
//
// The placement rule is a pure function of a chunk and a window, so these are
// one array in and one array out. The inputs are hand-authored on purpose:
// generating them with the merger under test would only prove it agrees with
// itself.
//
// EVERY placement here is in DURABLE ORDER, and every window is consistent
// with it. Hand-authoring makes it easy to write a chunk whose own timestamps
// contradict the order asserted for it — the first version of this file did
// exactly that (#1081 review, finding 2) and pinned an answer its own input
// refuted. If a case needs a chunk that is not in durable order, say so and
// say why it is reachable.
// ---------------------------------------------------------------------------

type TestEntry = { uuid: string; timestamp: string }

const at = (minute: number): string => `2026-09-20T09:${String(minute).padStart(2, '0')}:00.000Z`
const entry = (uuid: string, minute: number): TestEntry => ({ uuid, timestamp: at(minute) })

const a = entry('a', 0)
const b = entry('b', 1)
const c = entry('c', 2)
const d = entry('d', 3)
const e = entry('e', 4)
const f = entry('f', 5)
const undated = (uuid: string) => ({ uuid }) as unknown as TestEntry

/** The chunk, expressed the way the loader expresses it: entries the window
 *  has never seen are `fresh`, ones it already holds are an `anchor`. */
const chunk = (...items: Array<TestEntry | string>) =>
  items.map(item => (typeof item === 'string' ? { anchor: item } : { fresh: item })) as never

const uuids = (entries: readonly unknown[]): string[] =>
  entries.map(item => (item as TestEntry).uuid)

describe('a fresh entry lands before the anchor it precedes (#910 item 2)', () => {
  it('flushes the retained prefix first', () => {
    // The exact case from the issue.
    const placed = placeHistoryEntries(chunk(b, 'c'), [a, c] as never)
    expect(uuids(placed.entries)).toEqual(['a', 'b', 'c'])
    expect(placed.appendedAfterWindow).toBe(false)
  })

  it('handles several fresh entries before one anchor', () => {
    const placed = placeHistoryEntries(chunk(b, c, 'd'), [a, d] as never)
    expect(uuids(placed.entries)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('leaves a fresh entry AFTER the last anchor at the end', () => {
    const placed = placeHistoryEntries(chunk('b', c), [a, b] as never)
    expect(uuids(placed.entries)).toEqual(['a', 'b', 'c'])
  })

  it('does not flush against an anchor the loop will skip', () => {
    // `b` is not in the window (trimmed), so it is not an anchor at all and
    // must not pull the prefix forward; `f` is. With only the trimmed anchor
    // to go on, `c` would be emitted with nothing flushed ahead of it.
    //
    // (The first version of this case read `chunk(b, 'a', 'd')` over `[c,d]`
    // and asserted `['c','b','d']`. A trim drops the OLDEST side of the
    // window, so every trimmed uuid is older than every retained row — which
    // made `a < c` while the chunk's own order made `b < a`. The premise
    // refuted the assertion. #1081 review, finding 2.)
    const placed = placeHistoryEntries(chunk(c, 'b', 'f'), [d, e, f] as never)
    expect(uuids(placed.entries)).toEqual(['c', 'd', 'e', 'f'])
  })

  it('stops flushing at a retained row NEWER than the fresh entry', () => {
    // The other family of "the window holds a row the chunk skips": here `d`
    // is newer than the fresh `c`, so flushing the whole prefix up to anchor
    // `e` would put `c` after `d`. The anchor bound alone cannot tell this
    // case from the one above it; the timestamps can.
    const placed = placeHistoryEntries(chunk('b', c, 'e', f), [b, d, e] as never)
    expect(uuids(placed.entries)).toEqual(['b', 'c', 'd', 'e', 'f'])
  })

  it('flushes a retained row with the SAME timestamp, because a tie is not newer', () => {
    // Equal timestamps mean the relative order is unknown, and the rule for an
    // unknown order is the same everywhere in this file: flush. `isStrictlyNewer`
    // on the unanchored path uses the same strict comparison, so a tie there
    // prepends rather than appending.
    const tied = { uuid: 'x', timestamp: at(1) }
    const placed = placeHistoryEntries(chunk(b, 'c'), [tied, c] as never)
    expect(uuids(placed.entries)).toEqual(['x', 'b', 'c'])
  })

  it('flushes when either side is undated, the pre-timestamp behaviour', () => {
    // An unknown order is not evidence of one. Flushing is the better default
    // by a wide margin on the fuzz, and it is what the rule did before
    // timestamps entered it.
    const placed = placeHistoryEntries(chunk(b, 'c'), [undated('x'), c] as never)
    expect(uuids(placed.entries)).toEqual(['x', 'b', 'c'])
  })

  it('keeps scanning past a STALE anchor to one that still flushes', () => {
    // #1081 review, finding 3. `nextAnchorIndex` skips an anchor already
    // emitted; returning it instead would make the caller's flush loop a
    // no-op and leave `x` behind the fresh row. The window is out of durable
    // order — the state uuid dedup made permanent before item 2 — which is
    // why `a` is already emitted by the time `f` is placed.
    const placed = placeHistoryEntries(chunk('a', f, 'b', 'c'), [b, a, undated('x'), c] as never)
    expect(uuids(placed.entries)).toEqual(['b', 'a', 'x', 'f', 'c'])
  })
})

describe('the behaviours this must not disturb', () => {
  it('still PREPENDS a chunk that shares nothing and is not newer', () => {
    // With no following anchor the chunk does not reach back to the window,
    // and interleaving on a guess is what the unanchored rule exists to
    // refuse. Older rows above the window is missing-rows-in-order; the
    // alternative is rows out of order.
    const placed = placeHistoryEntries(chunk(a, b), [c, d] as never)
    expect(uuids(placed.entries)).toEqual(['a', 'b', 'c', 'd'])
    expect(placed.appendedAfterWindow).toBe(false)
  })

  it('still APPENDS a chunk that is strictly newer than the window', () => {
    // The stopped-reader case: the newest-N chunk no longer reaches back to
    // anything the pane holds, and prepending it put the newest turns above
    // the older ones permanently.
    const placed = placeHistoryEntries(chunk(c, d), [a, b] as never)
    expect(uuids(placed.entries)).toEqual(['a', 'b', 'c', 'd'])
    expect(placed.appendedAfterWindow).toBe(true)
  })

  it('emits the window untouched when the chunk is all anchors', () => {
    const placed = placeHistoryEntries(chunk('a', 'b'), [a, b] as never)
    expect(uuids(placed.entries)).toEqual(['a', 'b'])
  })

  it('keeps the window when the chunk is empty', () => {
    const placed = placeHistoryEntries(chunk(), [a, b] as never)
    expect(uuids(placed.entries)).toEqual(['a', 'b'])
  })
})

describe('keptWindowHead is what the pagination cursor keys on (#910 item 3)', () => {
  // The cursor names the OLDEST entry the pane holds, so the only question is
  // whether this load changed which one that is. `keptWindowHead` answers it
  // by observation rather than by inference from what the chunk contained —
  // which is the correction from #1081's review: item 2's prefix flush made
  // "this load added a fresh entry" stop implying "the head moved", and the
  // old `appendedAfterWindow || !addedFreshEntries` pair therefore jumped the
  // cursor onto a row that is no longer the oldest.
  it('is true when a fresh entry lands INSIDE the window, not above it', () => {
    // The exact case item 2 fixed. `a` is still the pane's oldest row, so the
    // cursor must stay on it; moving it to `b` would page the next older
    // chunk in above `a`.
    const placed = placeHistoryEntries(chunk(b, 'c'), [a, c] as never)
    expect(uuids(placed.entries)).toEqual(['a', 'b', 'c'])
    expect(placed.keptWindowHead).toBe(true)
  })

  it('is false when a fresh entry really does become the pane\'s oldest row', () => {
    // No following anchor, not strictly newer: the deliberate prepend. Here
    // the chunk's head IS the oldest row, so the cursor must move to it.
    const placed = placeHistoryEntries(chunk(a, b), [c, d] as never)
    expect(uuids(placed.entries)).toEqual(['a', 'b', 'c', 'd'])
    expect(placed.keptWindowHead).toBe(false)
  })

  it('is true for an all-anchor re-read of a tail the window already holds', () => {
    const placed = placeHistoryEntries(chunk('c', 'd'), [c, d] as never)
    expect(uuids(placed.entries)).toEqual(['c', 'd'])
    expect(placed.appendedAfterWindow).toBe(false)
    expect(placed.keptWindowHead).toBe(true)
  })

  it('is true for a strictly-newer append', () => {
    const placed = placeHistoryEntries(chunk(c, d), [a, b] as never)
    expect(placed.appendedAfterWindow).toBe(true)
    expect(placed.keptWindowHead).toBe(true)
  })

  it('is false against an empty window, where the chunk is everything the pane holds', () => {
    const placed = placeHistoryEntries(chunk(a, b), [] as never)
    expect(placed.keptWindowHead).toBe(false)
  })

  it('is false when there is no window and no chunk either', () => {
    // A window with no head cannot have kept it. Without the explicit
    // length guard this reads `undefined === undefined` and answers true —
    // harmless today, since the loader's marker falls back to the same value
    // either way, but the flag would be stating something false.
    const placed = placeHistoryEntries(chunk(), [] as never)
    expect(placed.keptWindowHead).toBe(false)
  })
})
