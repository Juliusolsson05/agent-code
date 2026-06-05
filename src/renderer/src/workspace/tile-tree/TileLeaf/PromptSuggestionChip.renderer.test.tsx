import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

import { PromptSuggestionChip } from './PromptSuggestionChip'

describe('PromptSuggestionChip', () => {
  it('renders nothing when text is empty', () => {
    const { container } = render(
      <PromptSuggestionChip text="" onApply={() => {}} onDismiss={() => {}} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('shows the suggestion and calls onApply with the text on click', () => {
    const onApply = vi.fn()
    render(<PromptSuggestionChip text="run the tests" onApply={onApply} onDismiss={() => {}} />)
    fireEvent.click(screen.getByText('run the tests'))
    expect(onApply).toHaveBeenCalledWith('run the tests')
  })

  it('calls onDismiss from the dismiss control', () => {
    const onDismiss = vi.fn()
    render(<PromptSuggestionChip text="commit this" onApply={() => {}} onDismiss={onDismiss} />)
    fireEvent.click(screen.getByLabelText('Dismiss suggestion'))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})
