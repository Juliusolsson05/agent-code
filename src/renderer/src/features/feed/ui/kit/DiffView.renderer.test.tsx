import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { DiffLine } from '@shared/parsers/lineDiff'

import { DiffView, keyDiffLines } from './DiffView'

function file(lines: DiffLine[]) {
  return [{ path: 'src/example.ts', action: 'update' as const, movedTo: null, lines }]
}

describe('DiffView streaming identity', () => {
  it('derives deterministic but duplicate-safe keys from logical lines', () => {
    const keyed = keyDiffLines([
      { kind: '+', text: '}' },
      { kind: '+', text: '}' },
      { kind: '-', text: '}' },
    ])

    expect(new Set(keyed.map(item => item.key)).size).toBe(3)
    expect(keyDiffLines([{ kind: '+', text: '}' }])[0]?.key).toBe(keyed[0]?.key)
  })

  it('preserves a sealed row DOM node when a parser inserts a neighboring line', () => {
    const first: DiffLine[] = [
      { kind: '+', text: 'const first = 1' },
      { kind: '+', text: 'const third = 3' },
    ]
    const { container, rerender } = render(<DiffView files={file(first)} />)
    const thirdBefore = Array.from(container.querySelectorAll('[data-diff-line-key]'))
      .find(row => row.textContent?.includes('const third'))
    expect(thirdBefore).toBeTruthy()

    rerender(
      <DiffView
        files={file([
          first[0],
          { kind: '+', text: 'const second = 2' },
          first[1],
        ])}
      />,
    )

    const thirdAfter = Array.from(container.querySelectorAll('[data-diff-line-key]'))
      .find(row => row.textContent?.includes('const third'))
    expect(thirdAfter).toBe(thirdBefore)
  })

  it('names added, removed, and context lines for assistive technology', () => {
    const { getByRole } = render(
      <DiffView
        files={file([
          { kind: '+', text: 'const added = true' },
          { kind: '-', text: 'const removed = true' },
          { kind: 'ctx', text: 'const unchanged = true' },
        ])}
      />,
    )

    expect(getByRole('listitem', { name: 'Added: const added = true' })).toBeTruthy()
    expect(getByRole('listitem', { name: 'Removed: const removed = true' })).toBeTruthy()
    expect(getByRole('listitem', { name: 'Context: const unchanged = true' })).toBeTruthy()
  })
})
