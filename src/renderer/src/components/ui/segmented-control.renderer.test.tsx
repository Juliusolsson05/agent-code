import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { SegmentedControl } from '@renderer/components/ui/segmented-control'

// The one segmented control (UI pass, G-10) and its two keyboard contracts.
const options = [
  { value: 'lan', label: 'LAN' },
  { value: 'tunnel', label: 'Tunnel' },
] as const

describe('SegmentedControl', () => {
  it('pressed semantics: every segment is a Tab stop and an arrow changes nothing', () => {
    // Remote's LAN/Tunnel uses this: switching starts or stops a tunnel, so an
    // arrow key must not do it.
    const onChange = vi.fn()
    render(<SegmentedControl label="Reach" value="lan" options={options} onChange={onChange} />)
    const [lan, tunnel] = within(screen.getByRole('group', { name: 'Reach' })).getAllByRole('button')
    expect(lan).toHaveAttribute('aria-pressed', 'true')
    expect([lan!.tabIndex, tunnel!.tabIndex]).toEqual([0, 0])
    fireEvent.keyDown(lan!, { key: 'ArrowRight' })
    expect(onChange).not.toHaveBeenCalled()
    // Re-choosing the active segment is a no-op.
    fireEvent.click(lan!)
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.click(tunnel!)
    expect(onChange).toHaveBeenCalledWith('tunnel')
  })

  it('radio semantics: one Tab stop, and arrows move AND select (k9)', () => {
    const onChange = vi.fn()
    render(<SegmentedControl semantics="radio" label="Layout" value="lan" options={options} onChange={onChange} />)
    const [lan, tunnel] = within(screen.getByRole('radiogroup', { name: 'Layout' })).getAllByRole('radio')
    expect([lan!.tabIndex, tunnel!.tabIndex]).toEqual([0, -1])
    lan!.focus()
    fireEvent.keyDown(lan!, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(tunnel)
    expect(onChange).toHaveBeenCalledWith('tunnel')
  })
})
