import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { NumberInput } from '@renderer/components/ui/number-input'

// NumberInput from the keyboard (plan K7/K8, ledger X3).
//
// The steppers were Tab stops whose focus ring the wrapper's overflow-hidden
// clipped, so every number field cost three Tabs, two of them invisible. The
// field is the one stop; ↑/↓ on it are the browser's native stepping, which
// happy-dom does not simulate, so that half sits in the owner checklist.

describe('NumberInput', () => {
  it('is a single Tab stop whose steppers still click', () => {
    const onChange = vi.fn()
    render(<NumberInput value={2} min={1} max={4} onChange={onChange} aria-label="Lanes" />)
    const tabbable = [...document.querySelectorAll<HTMLElement>('input, button')].filter(el => el.tabIndex >= 0)
    expect(tabbable).toEqual([screen.getByRole('spinbutton')])

    fireEvent.click(screen.getByRole('button', { name: 'Increase' }))
    expect(onChange).toHaveBeenLastCalledWith(3)
    fireEvent.click(screen.getByRole('button', { name: 'Decrease' }))
    expect(onChange).toHaveBeenLastCalledWith(1)
  })
})
