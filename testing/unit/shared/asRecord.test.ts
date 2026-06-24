import { describe, it, expect } from 'vitest'

import { asRecord, parseJsonRecord } from '@shared/lib/asRecord'

// The "object but not array, not null" invariant is easy to get subtly wrong
// (prior hand-written copies drifted on null vs arrays — see asRecord.ts). One
// app-local copy, codexResumeSanitizer's, used `typeof x === 'object' && x !==
// null`, which WRONGLY treats arrays as records. These tests pin the canonical
// behavior so a future edit can't silently re-admit arrays/null.

describe('asRecord', () => {
  it('accepts plain objects', () => {
    expect(asRecord({})).toEqual({})
    expect(asRecord({ a: 1 })).toEqual({ a: 1 })
  })

  it('rejects arrays (the historical drift bug)', () => {
    expect(asRecord([])).toBeNull()
    expect(asRecord([1, 2, 3])).toBeNull()
  })

  it('rejects null, undefined, and primitives', () => {
    expect(asRecord(null)).toBeNull()
    expect(asRecord(undefined)).toBeNull()
    expect(asRecord('str')).toBeNull()
    expect(asRecord(0)).toBeNull()
    expect(asRecord(false)).toBeNull()
  })
})

describe('parseJsonRecord', () => {
  it('parses a JSON object string into a record', () => {
    expect(parseJsonRecord('{"a":1}')).toEqual({ a: 1 })
  })

  it('returns null for valid JSON that is not an object', () => {
    expect(parseJsonRecord('[1,2,3]')).toBeNull()
    expect(parseJsonRecord('"str"')).toBeNull()
    expect(parseJsonRecord('42')).toBeNull()
    expect(parseJsonRecord('null')).toBeNull()
  })

  it('returns null for invalid JSON and for null/undefined input', () => {
    expect(parseJsonRecord('{not json')).toBeNull()
    expect(parseJsonRecord('')).toBeNull()
    expect(parseJsonRecord(null)).toBeNull()
    expect(parseJsonRecord(undefined)).toBeNull()
  })
})
