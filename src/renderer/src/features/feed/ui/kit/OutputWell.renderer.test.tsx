import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { OutputWell } from './OutputWell'

function openDetails(summary: HTMLElement) {
  const details = summary.closest('details')
  if (!details) throw new Error('expected summary to belong to details')
  details.open = true
  fireEvent(details, new Event('toggle'))
}

describe('OutputWell source safety', () => {
  it('announces a character cap for one long line and keeps exact source lazy', () => {
    const source = 'x'.repeat(200_001)
    render(<OutputWell text={source} ansi={false} />)

    expect(screen.getByRole('status').textContent).toContain('1 more character preserved')
    const sourceSummary = screen.getByText('Full output source (copyable)')
    expect(sourceSummary.closest('details')?.querySelector('[data-code-block-id]')).toBeNull()

    openDetails(sourceSummary)
    const sourceBlock = sourceSummary.closest('details')?.querySelector('[data-code-block-id]')
    expect(sourceBlock?.textContent).toBe(source)
  })
})
