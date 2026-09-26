import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { useListNavigation } from '@renderer/lib/useListNavigation'

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

  it('renders unknown times honestly and, when interactive, is a listbox of options that forwards selection', () => {
    // Interactive mode (Rewind to Prompt): listbox/option roles, because the
    // old listitem + aria-selected combination is not valid ARIA and the
    // highlight was announced as nothing (plan S7).
    const onSelect = vi.fn()
    function Interactive() {
      const nav = useListNavigation({ count: 1, onActivate: onSelect, idPrefix: 'p' })
      return <PromptList prompts={[{ text: 'a', timestamp: null }]} nav={nav} emptyMessage="none" />
    }
    render(<Interactive />)
    expect(screen.getByText('unknown time')).toBeInTheDocument()
    expect(screen.getByRole('listbox')).toHaveAttribute('aria-activedescendant', 'p-0')
    fireEvent.click(screen.getByText('a'))
    expect(onSelect).toHaveBeenCalledWith(0)
    expect(screen.getByRole('option')).toHaveAttribute('aria-selected', 'true')
  })

  it('shows the empty message when there is nothing to list', () => {
    render(<PromptList prompts={[]} emptyMessage="No visible user prompts found for this session." />)
    expect(screen.getByText('No visible user prompts found for this session.')).toBeInTheDocument()
  })
})
