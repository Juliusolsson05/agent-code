import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { formatPromptTime, PromptList } from './PromptList'

describe('PromptList', () => {
  it('shows every prompt with a relative time and the absolute time on hover, newest first', () => {
    const now = Date.now()
    const prompts = Array.from({ length: 40 }, (_, i) => ({ text: `prompt ${i}`, timestamp: now - i * 3600_000 }))
    render(<PromptList prompts={prompts} emptyMessage="none" />)
    expect(screen.getAllByRole('listitem')).toHaveLength(40)
    expect(screen.getByText('prompt 39')).toBeInTheDocument()
    expect(screen.getByText('3h ago')).toBeInTheDocument()
    expect(screen.getByText('3h ago')).toHaveAttribute('title', formatPromptTime(now - 3 * 3600_000).absolute!)
    // Row 0 is the newest prompt and carries the highest number.
    expect(screen.getAllByRole('listitem')[0]).toHaveTextContent('#40')
  })

  it('renders unknown times honestly and forwards selection', () => {
    const onSelect = vi.fn()
    render(<PromptList prompts={[{ text: 'a', timestamp: null }]} selectedIndex={0} onSelect={onSelect} emptyMessage="none" />)
    expect(screen.getByText('unknown time')).toBeInTheDocument()
    fireEvent.click(screen.getByText('a'))
    expect(onSelect).toHaveBeenCalledWith(0)
    expect(screen.getByRole('listitem')).toHaveAttribute('aria-selected', 'true')
  })

  it('shows the empty message when there is nothing to list', () => {
    render(<PromptList prompts={[]} emptyMessage="No visible user prompts found for this session." />)
    expect(screen.getByText('No visible user prompts found for this session.')).toBeInTheDocument()
  })
})
