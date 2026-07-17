import { describe, expect, it } from 'vitest'

import { mergeSearchMatchesWithBuffers } from './contentSearch'

describe('mergeSearchMatchesWithBuffers', () => {
  it('replaces stale disk hits with current unsaved buffer matches', () => {
    const result = mergeSearchMatchesWithBuffers(
      [
        {
          path: 'src/live.ts',
          line: 1,
          column: 1,
          preview: 'needle on disk',
          previewMatchOffset: 0,
          previewMatchLength: 6,
        },
        {
          path: 'src/other.ts',
          line: 2,
          column: 3,
          preview: '  needle',
          previewMatchOffset: 2,
          previewMatchLength: 6,
        },
      ],
      [{ path: 'src/live.ts', text: 'no disk result here\nNeedle in memory' }],
      'needle',
      false,
    )

    expect(result).toEqual({
      matches: [
        expect.objectContaining({
          path: 'src/live.ts',
          line: 2,
          column: 1,
          preview: 'Needle in memory',
          previewMatchOffset: 0,
          previewMatchLength: 6,
        }),
        expect.objectContaining({ path: 'src/other.ts', line: 2 }),
      ],
      truncated: false,
    })
  })

  it('uses main-search preview semantics and preserves the result cap', () => {
    const longPrefix = 'x'.repeat(210)
    const result = mergeSearchMatchesWithBuffers(
      [],
      [{ path: 'large.ts', text: `${longPrefix}hit hit` }],
      'hit',
      true,
      1,
    )

    expect(result.truncated).toBe(true)
    expect(result.matches).toEqual([
      expect.objectContaining({
        path: 'large.ts',
        line: 1,
        column: 211,
        previewMatchOffset: 80,
        previewMatchLength: 3,
      }),
    ])
  })

  it('does not count a preserved UTF-8 BOM as an editor column', () => {
    const result = mergeSearchMatchesWithBuffers(
      [],
      [{ path: 'bom.ts', text: '\ufeffneedle' }],
      'needle',
      true,
    )

    expect(result.matches).toEqual([
      expect.objectContaining({
        path: 'bom.ts',
        column: 1,
        preview: 'needle',
        previewMatchOffset: 0,
      }),
    ])
  })

  it('does not let a full disk result page crowd out unsaved matches', () => {
    const diskMatches = Array.from({ length: 500 }, (_, index) => ({
      path: `disk-${index}.ts`,
      line: 1,
      column: 1,
      preview: 'needle',
      previewMatchOffset: 0,
      previewMatchLength: 6,
    }))

    const result = mergeSearchMatchesWithBuffers(
      diskMatches,
      [{ path: 'unsaved.ts', text: 'needle' }],
      'needle',
      true,
    )

    expect(result.matches).toHaveLength(500)
    expect(result.matches[0]?.path).toBe('unsaved.ts')
    expect(result.truncated).toBe(true)
  })
})
