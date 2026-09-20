import { describe, expect, it } from 'vitest'

import {
  applyDecisionToWindow,
  decideHistoryBoundary,
  emptyHistoryWindow,
  isStaleHistoryChunk,
} from './historyBoundary.js'

// Pure decision coverage. Every rule mirrors a documented decision: resets
// need a strictly newer generation (reconnect re-delivery must not wipe a
// healthy window), caught-up never clears (its rows already arrived), and the
// chunk guard generalizes the phone's file-conflict rejection with generation
// awareness. The transport ordering these decisions assume (entries of the
// superseded generation flushed BEFORE the boundary, snapshot rows after it)
// is pinned by the forwarder and SessionFeedSource tests, not here.

const reset = (generation: number, file = '/t/chat_history.jsonl') =>
  ({ type: 'reset' as const, generation, snapshotByteLength: 100, file })
const caughtUp = (generation: number, file = '/t/chat_history.jsonl') =>
  ({ type: 'caught-up' as const, generation, snapshotByteLength: 100, byteOffset: 100, complete: true, file })

describe('decideHistoryBoundary', () => {
  it('applies the first reset ever seen', () => {
    const decision = decideHistoryBoundary(emptyHistoryWindow(), reset(2))
    expect(decision).toEqual({ kind: 'apply-reset', generation: 2, file: '/t/chat_history.jsonl' })
  })

  it('applies a strictly newer reset and ignores an equal or older one', () => {
    let window = applyDecisionToWindow(emptyHistoryWindow(), decideHistoryBoundary(window0(), reset(3)))
    expect(window).toEqual({ generation: 3, file: '/t/chat_history.jsonl', awaitingCaughtUp: true })
    // A late duplicate of the SAME generation (reconnect re-delivery) must not wipe the window.
    expect(decideHistoryBoundary(window, reset(3))).toMatchObject({ kind: 'stale' })
    expect(decideHistoryBoundary(window, reset(2))).toMatchObject({ kind: 'stale' })
    expect(decideHistoryBoundary(window, reset(4))).toMatchObject({ kind: 'apply-reset', generation: 4 })
    function window0() { return emptyHistoryWindow() }
  })

  it('observes caught-up for the open generation only, and never clears', () => {
    const window = applyDecisionToWindow(emptyHistoryWindow(), { kind: 'apply-reset', generation: 3, file: '/t/chat_history.jsonl' })
    expect(decideHistoryBoundary(window, caughtUp(3))).toMatchObject({ kind: 'observe-caught-up' })
    expect(decideHistoryBoundary(window, caughtUp(4))).toMatchObject({ kind: 'stale' })
    expect(decideHistoryBoundary(emptyHistoryWindow(), caughtUp(1))).toMatchObject({ kind: 'stale' })
    const closed = applyDecisionToWindow(window, decideHistoryBoundary(window, caughtUp(3)))
    expect(closed.awaitingCaughtUp).toBe(false)
  })
})

describe('isStaleHistoryChunk', () => {
  it('rejects a chunk naming a different file, and an older generation once one is known', () => {
    const window = { generation: 3, file: '/t/a.jsonl', awaitingCaughtUp: false }
    expect(isStaleHistoryChunk(window, { file: '/t/b.jsonl' })).toBe(true)
    expect(isStaleHistoryChunk(window, { file: '/t/a.jsonl', generation: 2 })).toBe(true)
    expect(isStaleHistoryChunk(window, { file: '/t/a.jsonl', generation: 3 })).toBe(false)
    // Pre-boundary providers keep the old behaviour exactly: only the file check fires.
    expect(isStaleHistoryChunk(emptyHistoryWindow(), { file: '/t/a.jsonl' })).toBe(false)
    expect(isStaleHistoryChunk(emptyHistoryWindow(), { file: '/t/other.jsonl' })).toBe(false)
  })
})
