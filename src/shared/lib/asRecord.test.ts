import { describe, expect, it } from 'vitest'

import {
  asRecord,
  asRecordArray,
  isRecord,
  parseJsonRecord,
} from '@shared/lib/asRecord'

describe('asRecord helpers', () => {
  it('accepts plain objects and rejects null, primitives, and arrays', () => {
    expect(asRecord({ ok: true })).toEqual({ ok: true })
    expect(asRecord(null)).toBeNull()
    expect(asRecord('x')).toBeNull()
    expect(asRecord(['not', 'a', 'record'])).toBeNull()
    expect(isRecord({ ok: true })).toBe(true)
    expect(isRecord([])).toBe(false)
  })

  it('filters arrays down to record entries', () => {
    expect(asRecordArray([{ a: 1 }, null, ['x'], { b: 2 }])).toEqual([
      { a: 1 },
      { b: 2 },
    ])
    expect(asRecordArray({ a: 1 })).toEqual([])
  })

  it('parses JSON objects without throwing for malformed or non-object input', () => {
    expect(parseJsonRecord('{"a":1}')).toEqual({ a: 1 })
    expect(parseJsonRecord('[1,2,3]')).toBeNull()
    expect(parseJsonRecord('{')).toBeNull()
    expect(parseJsonRecord(undefined)).toBeNull()
  })
})
