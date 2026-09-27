import { describe, expect, it } from 'vitest'

import { PER_CONVERSATION_CAP, CONVERSATION_CAP, TransportGapLedger } from './transportGapLedger.js'

// #1381: the durable gap rows' store. Bounded so a closed pane's records (kept
// on purpose, see the module comment) can never grow without limit.
describe('TransportGapLedger', () => {
  it('keeps each session\'s records in order with ids unique across sessions', () => {
    const ledger = new TransportGapLedger()
    const a = ledger.record('s1', { since: 1, until: 2, lostGenerations: 1 })
    const b = ledger.record('s2', { since: 3, until: 4, lostGenerations: 1 })
    const c = ledger.record('s1', { since: 5, until: 6, lostGenerations: 2 })
    expect(ledger.list('s1')).toEqual([a, c])
    expect(ledger.list('s2')).toEqual([b])
    expect(new Set([a.id, b.id, c.id]).size).toBe(3)
  })

  it('keeps only the newest records of one session', () => {
    const ledger = new TransportGapLedger()
    for (let i = 0; i < PER_CONVERSATION_CAP + 3; i += 1) ledger.record('s1', { since: i, until: i + 1, lostGenerations: 1 })
    const held = ledger.list('s1')
    expect(held).toHaveLength(PER_CONVERSATION_CAP)
    expect(held[0]!.since).toBe(3)
  })

  it('evicts the session that recorded least recently past the session cap', () => {
    const ledger = new TransportGapLedger()
    for (let i = 0; i < CONVERSATION_CAP; i += 1) ledger.record(`s${i}`, { since: i, until: i, lostGenerations: 1 })
    // s0 records again, so s1 is now the least recent and is the one evicted.
    ledger.record('s0', { since: 0, until: 0, lostGenerations: 1 })
    ledger.record('new', { since: 0, until: 0, lostGenerations: 1 })
    expect(ledger.list('s0')).toHaveLength(2)
    expect(ledger.list('s1')).toEqual([])
    expect(ledger.list('new')).toHaveLength(1)
  })
})
