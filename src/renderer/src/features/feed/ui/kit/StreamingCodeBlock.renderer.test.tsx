import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { StreamingCodeBlock } from './StreamingCodeBlock'

describe('StreamingCodeBlock diff tone', () => {
  it('paints every materialized Write line as an addition without a phantom tail', () => {
    const { container } = render(
      <StreamingCodeBlock
        code={'const one = 1\nconst two = 2\n'}
        path="src/write.ts"
        blockKey="write:1"
        lineTone="addition"
      />,
    )

    const rows = container.querySelectorAll('[data-diff-kind="+"]')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.textContent).toContain('+const one = 1')
    expect(rows[1]?.textContent).toContain('+const two = 2')
  })

  it('keeps sealed line nodes mounted while the live tail grows', () => {
    const { container, rerender } = render(
      <StreamingCodeBlock
        code={'const sealed = true\nconst tail ='}
        path="src/write.ts"
        blockKey="write:stable"
        lineTone="addition"
      />,
    )
    const sealedBefore = container.querySelector(
      '[data-stream-line-key="write:stable:sealed:0"]',
    )

    rerender(
      <StreamingCodeBlock
        code={'const sealed = true\nconst tail = 42'}
        path="src/write.ts"
        blockKey="write:stable"
        lineTone="addition"
      />,
    )

    expect(
      container.querySelector('[data-stream-line-key="write:stable:sealed:0"]'),
    ).toBe(sealedBefore)
  })

  it('exposes Write rows as added lines instead of relying on green alone', () => {
    const { getByRole } = render(
      <StreamingCodeBlock
        code="const accessible = true"
        path="src/write.ts"
        blockKey="write:accessible"
        lineTone="addition"
      />,
    )

    expect(
      getByRole('listitem', { name: 'Added: const accessible = true' }),
    ).toBeTruthy()
  })

  it('invalidates every sealed row when an earlier line changes under the same key', () => {
    const { container, rerender } = render(
      <StreamingCodeBlock
        code={'const first = 1\nconst middle = 2\nconst last = 3\n'}
        path="src/write.ts"
        blockKey="write:repaired-prefix"
        lineTone="addition"
      />,
    )
    expect(container.textContent).toContain('const first = 1')

    // The last sealed line stays identical. A last-line-only divergence probe
    // used to miss this repair and keep painting stale `first = 1` forever.
    rerender(
      <StreamingCodeBlock
        code={'const first = 10\nconst middle = 2\nconst last = 3\n'}
        path="src/write.ts"
        blockKey="write:repaired-prefix"
        lineTone="addition"
      />,
    )

    expect(
      container.querySelector('[data-stream-line-key="write:repaired-prefix:sealed:0"]')
        ?.textContent?.trimEnd(),
    ).toBe('+const first = 10')
  })
})
