import { describe, expect, it } from 'vitest'

import { CompletionLedger } from './completionLedger.js'

// #743: results of unrelated tools must age out; a sub-agent's result, once
// looked up by the watcher, must never be forgotten for the session.

describe('CompletionLedger', () => {
  it('reports whether a record changed anything', () => {
    const ledger = new CompletionLedger(8)
    expect(ledger.record('t1', 'done')).toBe(true)
    expect(ledger.record('t1', 'done')).toBe(false)
    expect(ledger.record('t1', 'error')).toBe(true)
    expect(ledger.lookup('t1')).toBe('error')
  })

  it('evicts the oldest unclaimed results once the recent window is full', () => {
    const ledger = new CompletionLedger(3)
    ledger.record('a', 'done')
    ledger.record('b', 'done')
    ledger.record('c', 'done')
    ledger.record('d', 'done')
    expect(ledger.recentSize).toBe(3)
    expect(ledger.lookup('a')).toBeUndefined()
    expect(ledger.lookup('d')).toBe('done')
  })

  it('keeps a claimed result through any number of later records', () => {
    const ledger = new CompletionLedger(3)
    ledger.record('agent-1', 'done')
    // The watcher asks once; from now on the id is a sub-agent's.
    expect(ledger.lookup('agent-1')).toBe('done')
    for (let i = 0; i < 100; i += 1) ledger.record(`tool-${i}`, 'done')
    expect(ledger.recentSize).toBe(3)
    expect(ledger.claimedSize).toBe(1)
    expect(ledger.lookup('agent-1')).toBe('done')
  })

  it('updates a claimed status in place when the parent re-records it', () => {
    const ledger = new CompletionLedger(3)
    ledger.record('agent-1', 'done')
    expect(ledger.lookup('agent-1')).toBe('done')
    expect(ledger.record('agent-1', 'error')).toBe(true)
    expect(ledger.record('agent-1', 'error')).toBe(false)
    expect(ledger.lookup('agent-1')).toBe('error')
    expect(ledger.recentSize).toBe(0)
  })

  it('answers undefined for an id it never saw', () => {
    const ledger = new CompletionLedger(3)
    expect(ledger.lookup('nope')).toBeUndefined()
  })

  it('rejects a non-positive window', () => {
    expect(() => new CompletionLedger(0)).toThrow(RangeError)
  })
})
