import { describe, expect, it } from 'vitest'

import { CappedTextBuffer } from './cappedTextBuffer.js'

describe('CappedTextBuffer', () => {
  it('starts empty and ignores empty appends', () => {
    const buffer = new CappedTextBuffer(8)
    buffer.append('')
    expect(buffer.length).toBe(0)
    expect(buffer.read()).toBe('')
  })

  it('rejects a non-positive cap', () => {
    expect(() => new CappedTextBuffer(0)).toThrow(RangeError)
  })

  it('keeps the newest whole chunks under the cap, oldest first', () => {
    const buffer = new CappedTextBuffer(10)
    buffer.append('abcd')
    buffer.append('efgh')
    expect(buffer.read()).toBe('abcdefgh')
    buffer.append('ijkl')
    // 12 > 10: the oldest whole chunk goes, not a partial one.
    expect(buffer.read()).toBe('efghijkl')
    expect(buffer.length).toBe(8)
  })

  it('never exceeds the cap and drops the minimum number of whole chunks', () => {
    const cap = 1000
    const buffer = new CappedTextBuffer(cap)
    const appended: string[] = []
    let seed = 7
    for (let i = 0; i < 5_000; i += 1) {
      seed = (seed * 48271) % 2147483647
      const chunk = String.fromCharCode(97 + (i % 26)).repeat(1 + (seed % 300))
      appended.push(chunk)
      buffer.append(chunk)

      expect(buffer.length).toBeLessThanOrEqual(cap)
      // Reconstruct the expected retained suffix in whole chunks.
      let expected = ''
      let dropped: string | null = null
      for (let j = appended.length - 1; j >= 0; j -= 1) {
        const candidate = appended[j]!
        if (expected.length + candidate.length > cap) {
          dropped = candidate
          break
        }
        expected = candidate + expected
      }
      expect(buffer.read()).toBe(expected)
      if (dropped !== null) {
        // Minimal drop: putting the last dropped chunk back would overflow.
        expect(buffer.length + dropped.length).toBeGreaterThan(cap)
      }
    }
  })

  it('keeps only the tail of a chunk larger than the cap', () => {
    const buffer = new CappedTextBuffer(8, 2)
    buffer.append('old')
    buffer.append('0123456789abcdef')
    expect(buffer.read()).toBe('89abcdef')
    expect(buffer.length).toBe(8)
    // Later appends continue from that tail: the oversized chunk was stored
    // as pieces, so only the oldest piece goes, not the whole replay.
    buffer.append('xy')
    expect(buffer.read()).toBe('abcdefxy')
  })

  it('bounds overflow loss to one piece even for a near-cap chunk', () => {
    const buffer = new CappedTextBuffer(64, 8)
    buffer.append('a'.repeat(60))
    buffer.append('bbbb')
    expect(buffer.length).toBe(64)
    buffer.append('c')
    // 65 > 64: one 8-unit piece of the 60-unit chunk is dropped, not all of it.
    expect(buffer.length).toBe(57)
    expect(buffer.read()).toBe('a'.repeat(52) + 'bbbbc')
  })

  it('never splits a surrogate pair across pieces', () => {
    const buffer = new CappedTextBuffer(64, 3)
    // Pairs land on every candidate boundary for a 3-unit piece size.
    const chunk = 'a\u{1F600}b\u{1F600}\u{1F600}c'
    buffer.append(chunk)
    expect(buffer.read()).toBe(chunk)
    // Drop pieces one at a time and confirm the retained prefix boundary is
    // always a whole code point: no lone surrogate ever leads the buffer.
    for (let i = 0; i < 6; i += 1) {
      buffer.append('x'.repeat(60))
      const first = buffer.read().charCodeAt(0)
      expect(first >= 0xdc00 && first <= 0xdfff).toBe(false)
    }
  })

  it('does not start the tail of an oversized chunk on a low surrogate', () => {
    // 'ab' + 😀 (two code units) + 'cd' is six code units.
    const chunk = 'ab\u{1F600}cd'
    const onHigh = new CappedTextBuffer(4)
    onHigh.append(chunk)
    expect(onHigh.read()).toBe('\u{1F600}cd')

    const onLow = new CappedTextBuffer(3)
    onLow.append(chunk)
    // A 3-unit tail would begin with the low surrogate; drop it instead.
    expect(onLow.read()).toBe('cd')
  })

  it('stays correct across lazy compaction of the dropped prefix', () => {
    const buffer = new CappedTextBuffer(50)
    for (let i = 0; i < 1_000; i += 1) {
      buffer.append(`${i}|`.padStart(5, '0'))
    }
    expect(buffer.length).toBeLessThanOrEqual(50)
    expect(buffer.read().endsWith('0999|')).toBe(true)
    expect(buffer.read().length).toBe(50)
  })
})
