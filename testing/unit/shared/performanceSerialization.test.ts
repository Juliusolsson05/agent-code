import { describe, it, expect } from 'vitest'

import {
  serializePerformanceError,
  sanitizePerformanceData,
  areaFromPerformanceName,
} from '@shared/performance/serialization'

// These pin a PRIVACY control. The sanitizer drops sensitive fields when not
// verbose; if these invariants regress, telemetry could leak prompts/secrets.

describe('sanitizePerformanceData', () => {
  it('drops sensitive keys when not verbose', () => {
    const out = sanitizePerformanceData(
      { prompt: 'hi', content: 'x', token: 't', secret: 's', apiKey: 'k', safe: 1 },
      { verbose: false },
    )
    expect(out).toEqual({ safe: 1 })
  })

  it('keeps sensitive keys when verbose', () => {
    const out = sanitizePerformanceData({ prompt: 'hi', safe: 1 }, { verbose: true })
    expect(out).toEqual({ prompt: 'hi', safe: 1 })
  })

  it('truncates long strings to 300 chars + ... when not verbose', () => {
    const out = sanitizePerformanceData({ note: 'a'.repeat(500) }, { verbose: false })
    expect((out!.note as string).length).toBe(303)
    expect(out!.note).toBe(`${'a'.repeat(300)}...`)
  })

  it('truncates long strings to 2000 chars + ... when verbose', () => {
    const out = sanitizePerformanceData({ note: 'a'.repeat(2500) }, { verbose: true })
    expect((out!.note as string).length).toBe(2003)
  })

  it('passes non-string values through and returns undefined for no data', () => {
    expect(sanitizePerformanceData({ n: 5, b: true, o: { x: 1 } }, { verbose: false })).toEqual({
      n: 5,
      b: true,
      o: { x: 1 },
    })
    expect(sanitizePerformanceData(undefined, { verbose: false })).toBeUndefined()
  })
})

describe('serializePerformanceError', () => {
  it('extracts name/message/stack from an Error', () => {
    const e = new TypeError('boom')
    const out = serializePerformanceError(e)
    expect(out).toMatchObject({ name: 'TypeError', message: 'boom' })
    expect(typeof out!.stack).toBe('string')
  })

  it('stringifies non-Error values', () => {
    expect(serializePerformanceError('nope')).toEqual({ message: 'nope' })
    expect(serializePerformanceError(42)).toEqual({ message: '42' })
  })
})

describe('areaFromPerformanceName', () => {
  it('takes the first two dotted segments', () => {
    expect(areaFromPerformanceName('session.spawn.providerCreate', 'app')).toBe('session.spawn')
  })

  it('uses the process-specific fallback for an empty name', () => {
    expect(areaFromPerformanceName('', 'app')).toBe('app')
    expect(areaFromPerformanceName('', 'renderer')).toBe('renderer')
  })

  it('returns the single segment when there is no dot', () => {
    expect(areaFromPerformanceName('boot', 'app')).toBe('boot')
  })
})
