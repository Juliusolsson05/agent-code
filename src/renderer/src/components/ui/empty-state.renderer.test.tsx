import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { EmptyState } from '@renderer/components/ui/empty-state'

// The one "nothing here" look (UI pass, G-14): two sizes, and an announced
// status when it replaces live results.
describe('EmptyState', () => {
  it('announces when it replaces results, and has one list and one inline size', () => {
    const { rerender } = render(<EmptyState role="status">No matches.</EmptyState>)
    expect(screen.getByRole('status')).toHaveTextContent('No matches.')
    expect(screen.getByRole('status').className).toMatch(/\btext-center\b/)
    rerender(<EmptyState size="inline">None yet.</EmptyState>)
    expect(screen.getByText('None yet.').className).not.toMatch(/\btext-center\b/)
  })
})
