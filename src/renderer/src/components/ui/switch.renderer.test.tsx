import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { Switch } from '@renderer/components/ui/switch'

// The shared row switch (ledger G-34). The contract that the three call sites
// (Skills, MCP servers, provider enablement) now rely on: it is a real switch
// to assistive tech, it reports the NEXT value, and the knob moves, so the
// state is never carried by the fill colour alone.

function Harness({ onChange }: { onChange?: (next: boolean) => void }) {
  const [on, setOn] = useState(false)
  return <Switch checked={on} aria-label="Grok" onCheckedChange={next => { onChange?.(next); setOn(next) }} />
}

describe('Switch', () => {
  it('is a switch that flips and reports the next value', () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    const control = screen.getByRole('switch', { name: 'Grok' })
    expect(control).toHaveAttribute('aria-checked', 'false')
    expect(control).toHaveAttribute('type', 'button')

    fireEvent.click(control)
    expect(onChange).toHaveBeenLastCalledWith(true)
    expect(control).toHaveAttribute('aria-checked', 'true')
    expect(control).toHaveAttribute('data-state', 'on')
    // The knob moves as well: position, not only colour, says "on".
    expect(control.querySelector('span')!.className).toContain('translate-x-2.5')

    fireEvent.click(control)
    expect(onChange).toHaveBeenLastCalledWith(false)
    expect(control.querySelector('span')!.className).toContain('translate-x-0')
  })

  it('does not flip while disabled', () => {
    const onChange = vi.fn()
    render(<Switch checked={false} disabled aria-label="Grok" onCheckedChange={onChange} />)
    fireEvent.click(screen.getByRole('switch', { name: 'Grok' }))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('lets a caller veto the flip from onClick', () => {
    const onChange = vi.fn()
    render(<Switch checked={false} aria-label="Grok" onClick={event => event.preventDefault()} onCheckedChange={onChange} />)
    fireEvent.click(screen.getByRole('switch', { name: 'Grok' }))
    expect(onChange).not.toHaveBeenCalled()
  })
})
