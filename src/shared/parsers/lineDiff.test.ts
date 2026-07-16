import { describe, expect, it, vi } from 'vitest'

import { diffLines, streamingDiffLines } from './lineDiff'

describe('bounded line diff', () => {
  it('uses only proven common prefix while new text is still streaming', () => {
    expect(streamingDiffLines(
      'shared\nold one\nold two',
      'shared\nnew partial',
    )).toEqual([
      { kind: 'ctx', text: 'shared' },
      { kind: '-', text: 'old one' },
      { kind: '-', text: 'old two' },
      { kind: '+', text: 'new partial' },
    ])
  })

  it('falls back to an honest linear diff before allocating a huge LCS matrix', () => {
    const before = ['shared', ...Array.from({ length: 1_500 }, (_, i) => `old ${i}`), 'tail'].join('\n')
    const after = ['shared', ...Array.from({ length: 1_500 }, (_, i) => `new ${i}`), 'tail'].join('\n')
    const lines = diffLines(before, after)

    expect(lines[0]).toEqual({ kind: 'ctx', text: 'shared' })
    expect(lines.at(-1)).toEqual({ kind: 'ctx', text: 'tail' })
    expect(lines.filter(line => line.kind === '-')).toHaveLength(1_500)
    expect(lines.filter(line => line.kind === '+')).toHaveLength(1_500)
  })

  it('never allocates an LCS matrix when either side is empty', () => {
    // A small empty-side fixture would produce the same visible answer through
    // the old implementation, so assert the resource invariant directly. This
    // catches the regression where `m*n === 0` bypassed the guard even though
    // `(m+1)*(n+1)` was still allocated immediately afterward.
    vi.stubGlobal('Int32Array', class ForbiddenLcsAllocation {
      constructor() {
        throw new Error('empty-side diff must not allocate an LCS matrix')
      }
    })
    try {
      expect(diffLines('', 'first\nsecond')).toEqual([
        { kind: '+', text: 'first' },
        { kind: '+', text: 'second' },
      ])
      expect(diffLines('first\nsecond', '')).toEqual([
        { kind: '-', text: 'first' },
        { kind: '-', text: 'second' },
      ])
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
