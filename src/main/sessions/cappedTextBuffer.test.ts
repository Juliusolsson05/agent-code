import { describe, expect, it } from 'vitest'

import { CappedTextBuffer } from './cappedTextBuffer.js'

describe('CappedTextBuffer', () => {
  it('starts empty and ignores empty appends', () => {
    const buffer = new CappedTextBuffer(8)
    buffer.append('')
    expect(buffer.length).toBe(0)
    expect(buffer.read()).toBe('')
  })

  it('rejects a non-positive cap and a piece size that cannot hold a surrogate pair', () => {
    expect(() => new CappedTextBuffer(0)).toThrow(RangeError)
    expect(() => new CappedTextBuffer(8, 1)).toThrow(RangeError)
    expect(() => new CappedTextBuffer(8, 2.5)).toThrow(RangeError)
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
    // With a 3-unit piece the naive cuts would land INSIDE both pairs
    // (ab|😀 → 'ab' + high, then …); the boundary must pull back so the
    // pieces come out as 'ab', '😀c', 'd😀', 'e'.
    const chunk = 'ab\u{1F600}cd\u{1F600}e'
    buffer.append(chunk)
    expect(buffer.read()).toBe(chunk)
    // Evict exactly one piece at a time (cap 64, 9 units retained): each
    // step's retained text pins the piece boundaries. Without the pull-back
    // the pieces would be 'ab\uD83D', '\uDE00cd', … and the second step
    // would leave a lone low surrogate at the head.
    buffer.append('x'.repeat(57))
    expect(buffer.read()).toBe('\u{1F600}cd\u{1F600}e' + 'x'.repeat(57))
    buffer.append('xx')
    expect(buffer.read()).toBe('d\u{1F600}e' + 'x'.repeat(59))
    buffer.append('xxx')
    expect(buffer.read()).toBe('e' + 'x'.repeat(62))
  })

  it('holds its invariants with piece cutting and oversized chunks under fuzz', () => {
    const cap = 1000
    const pieceSize = 37
    const buffer = new CappedTextBuffer(cap, pieceSize)
    // The oracle only needs the newest `cap + maxUnits` code units: the
    // buffer can never hold more than `cap`, so `endsWith` below never looks
    // further back. Keeping the whole stream made this quadratic — every
    // `+=` built a cons string and every `endsWith` flattened it, copying a
    // ~3 MB stream per iteration (4,000 × ~1.5 MB); it took 20–50 s on a
    // loaded machine and tripped vitest's 5 s timeout.
    const maxUnits = 1_500
    let stream = ''
    let streamTotal = 0
    let seed = 11
    const alphabet = ['a', 'b', '\u{1F600}', 'c', '\u{1F4A9}', 'd']
    for (let i = 0; i < 4_000; i += 1) {
      seed = (seed * 48271) % 2147483647
      const units = 1 + (seed % maxUnits)
      let chunk = ''
      while (chunk.length < units) chunk += alphabet[(seed + chunk.length) % alphabet.length]!
      stream = (stream + chunk).slice(-(cap + maxUnits))
      streamTotal += chunk.length
      buffer.append(chunk)

      const text = buffer.read()
      expect(text.length).toBe(buffer.length)
      expect(buffer.length).toBeLessThanOrEqual(cap)
      expect(stream.endsWith(text)).toBe(true)
      // The oracle is trimmed, so it cannot answer "has the stream passed
      // the cap" by its own length any more; the running total can.
      if (streamTotal > cap) expect(buffer.length).toBeGreaterThan(cap - pieceSize)
      const first = text.charCodeAt(0)
      expect(first >= 0xdc00 && first <= 0xdfff).toBe(false)
    }
    // 4,000 iterations is well under a second of CPU; the generous budget is
    // for a loaded machine running several vitest workers, where the default
    // 5 s was tripped by contention rather than by the test.
  }, 20_000)

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
    const chunks: string[] = []
    for (let i = 0; i < 1_000; i += 1) {
      const chunk = `${i}|`.padStart(5, '0')
      chunks.push(chunk)
      buffer.append(chunk)
    }
    expect(buffer.length).toBe(50)
    expect(buffer.read()).toBe(chunks.slice(-10).join(''))
  })
})
