import { useRef } from 'react'
import { render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { usePickerAutoScroll } from './usePickerAutoScroll'

afterEach(() => vi.restoreAllMocks())

function Harness({ selected }: { selected: string | null }) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  usePickerAutoScroll({
    scrollerRef,
    pickerSelectedUuid: selected,
    codeBlockSelectedId: null,
  })
  return (
    <div ref={scrollerRef}>
      <div data-entry-uuid="assistant-1">first block</div>
      <div data-entry-uuid="assistant-1">second block</div>
      <div data-entry-uuid="assistant-2">another entry</div>
    </div>
  )
}

describe('assistant picker over projected entry parts', () => {
  it('creates one non-owning outline for every block in the selected entry', async () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1)
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
    const { container, rerender } = render(<Harness selected="assistant-1" />)

    await waitFor(() => {
      expect(container.querySelectorAll('[data-entry-selection-overlay]')).toHaveLength(1)
    })
    expect(
      container.querySelector('[data-entry-selection-overlay="assistant-1"]')
        ?.getAttribute('aria-hidden'),
    ).toBe('true')
    // The entry parts stay siblings with their own React keys. Selection must
    // not wrap/reparent operations merely to draw one visual boundary.
    expect(container.querySelectorAll('[data-entry-uuid="assistant-1"]')).toHaveLength(2)

    rerender(<Harness selected={null} />)
    expect(container.querySelector('[data-entry-selection-overlay]')).toBeNull()
  })
})
