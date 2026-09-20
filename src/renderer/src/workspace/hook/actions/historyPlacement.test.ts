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
// ---------------------------------------------------------------------------

type TestEntry = { uuid: string; timestamp: string }

const at = (minute: number): string => `2026-09-20T09:${String(minute).padStart(2, '0')}:00.000Z`
const entry = (uuid: string, minute: number): TestEntry => ({ uuid, timestamp: at(minute) })

const a = entry('a', 0)
const b = entry('b', 1)
const c = entry('c', 2)
const d = entry('d', 3)

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
    // `a` is not in the window (trimmed), so it is not an anchor at all and
    // must not pull the prefix forward. `d` is.
    const placed = placeHistoryEntries(chunk(b, 'a', 'd'), [c, d] as never)
    expect(uuids(placed.entries)).toEqual(['c', 'b', 'd'])
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

describe('a no-op tail refresh (#910 item 3)', () => {
  // The placement half of the cursor bug: re-reading a tail the window already
  // holds produces an ALL-ANCHOR placement. The loader used to read
  // `appendedAfterWindow: false` from that and move the pagination cursor to
  // the chunk's head — so the next older page landed above everything the pane
  // had already paged in.
  //
  // What this pins is the input the loader keys on: such a chunk contributes
  // no fresh entry, and the loader's own guard is `placement.some(fresh)`.
  it('contributes no fresh entry, which is what the loader keys on', () => {
    const placement = chunk('c', 'd')
    expect((placement as Array<Record<string, unknown>>).some(item => 'fresh' in item)).toBe(false)
    const placed = placeHistoryEntries(placement, [c, d] as never)
    expect(uuids(placed.entries)).toEqual(['c', 'd'])
    // Not an append either — so `appendedAfterWindow` alone could not tell the
    // loader to leave the cursor where it was.
    expect(placed.appendedAfterWindow).toBe(false)
  })

  it('a chunk that DOES add something still reports a fresh entry', () => {
    const placement = chunk(b, 'c')
    expect((placement as Array<Record<string, unknown>>).some(item => 'fresh' in item)).toBe(true)
  })
})
