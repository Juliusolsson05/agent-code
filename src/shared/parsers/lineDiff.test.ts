import { describe, expect, it } from 'vitest'

import { canDiffLinesInline, diffLines } from './lineDiff'

describe('line diff admission', () => {
  it('admits ordinary edits and preserves their line-level diff', () => {
    expect(canDiffLinesInline('one\ntwo', 'one\nthree')).toBe(true)
    expect(diffLines('one\ntwo', 'one\nthree')).toEqual([
      { kind: 'ctx', text: 'one' },
      { kind: '+', text: 'three' },
      { kind: '-', text: 'two' },
    ])
  })

  it('rejects edits whose LCS table or source would exceed renderer bounds', () => {
    const manyLines = Array.from({ length: 1_500 }, (_, index) => String(index)).join('\n')
    expect(canDiffLinesInline(manyLines, manyLines)).toBe(false)
    expect(canDiffLinesInline('x'.repeat(32 * 1024), 'y')).toBe(false)
  })
})
