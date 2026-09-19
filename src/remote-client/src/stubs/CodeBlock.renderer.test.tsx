import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { CodeBlock } from './CodeBlock'

// WHY these tests exist: the phone stub used to highlight and mount the
// ENTIRE `code` string in one <pre> — it never inherited the desktop's
// boundedText discipline (16KB pages, collapsed preview). Expanding a large
// Read on a phone therefore froze the renderer, the exact failure class the
// desktop's pagination was built to kill. These tests pin the stub to the
// SAME contract: under-budget inline, over-budget collapsed-with-controls,
// paged expansion, and the cheap streaming path.
//
// The budget functions themselves are imported from @renderer/lib/text/
// boundedText (pure, no Electron) rather than reimplemented — drift between
// the two CodeBlocks is the bug this file guards against.

describe('phone CodeBlock stub', () => {
  it('renders under-budget code inline with the desktop markup contract', () => {
    const { container } = render(<CodeBlock code={'const a = 1'} language="typescript" />)
    const pre = container.querySelector('pre')
    expect(pre).not.toBeNull()
    // The static classes the desktop's own static path carries — the stub
    // dropped px-3/py-2/text-code-ink at birth, leaving unpadded slabs in
    // the wrong ink everywhere a code surface rendered outside .prose-theme.
    expect(pre?.className).toContain('code-block-static')
    expect(pre?.className).toContain('px-3')
    expect(pre?.className).toContain('py-2')
    expect(pre?.className).toContain('text-code-ink')
    expect(container.textContent).toContain('const a = 1')
  })

  it('collapses over-budget content instead of mounting the whole string', () => {
    // 20k chars on one line: over the 16KB page budget.
    const big = 'x'.repeat(20_000)
    const { container, getByText } = render(<CodeBlock code={big} language="plaintext" />)
    // The full payload must NOT be mounted — collapsed preview only.
    const pre = container.querySelector('pre')
    expect(pre?.textContent?.length ?? 0).toBeLessThan(big.length)
    // Explicit expansion affordance, mirroring the desktop controls.
    expect(getByText('view paged content')).toBeTruthy()
  })

  it('pages content after explicit expansion', () => {
    const big = `${'line\n'.repeat(5_000)}`
    const { getByText, container } = render(<CodeBlock code={big} language="plaintext" />)
    fireEvent.click(getByText('view paged content'))
    // Paged view shows exactly one bounded page plus the paging controls.
    expect(getByText('collapse')).toBeTruthy()
    expect(getByText('next')).toBeTruthy()
    const pre = container.querySelector('pre')
    // 5k lines at ~5 chars/line = ~25k chars; a page is line-bounded at 400
    // lines, so the mounted text must be far smaller than the source.
    expect(pre?.textContent?.length ?? 0).toBeLessThan(big.length)
  })

  it('keeps the highlight=false cheap streaming path as plain text', () => {
    const { container } = render(<CodeBlock code={'streaming…'} highlight={false} />)
    const code = container.querySelector('pre > code')
    expect(code?.textContent).toBe('streaming…')
    // No hljs markup on the streaming path — the caller opted out.
    expect(code?.innerHTML).toBe('streaming…')
  })
})
