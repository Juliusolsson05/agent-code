import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { Select } from '@renderer/components/ui/select'

// The shared native select (UI pass, G-11). It stays a real <select> (so the
// platform keyboard and the focused-control-owns-Enter rule keep working) and
// carries the one focus ring several hand-styled selects lacked.
describe('Select', () => {
  it('is a native select with the shared focus ring', () => {
    const onChange = vi.fn()
    render(
      <Select aria-label="Range" defaultValue="1" onChange={onChange}>
        <option value="1">1 hour</option>
        <option value="24">24 hours</option>
      </Select>,
    )
    const select = screen.getByRole('combobox', { name: 'Range' })
    expect(select.tagName).toBe('SELECT')
    expect(select.className).toMatch(/focus-visible:ring-focus-ring/)
    fireEvent.change(select, { target: { value: '24' } })
    expect(onChange).toHaveBeenCalledTimes(1)
  })
})
