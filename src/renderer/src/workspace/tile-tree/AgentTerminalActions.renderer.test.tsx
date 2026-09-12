import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { AgentTerminalActions } from './AgentTerminalActions'

describe('AgentTerminalActions', () => {
  it('renders exactly one always-enabled Submit button', () => {
    render(<AgentTerminalActions onSubmit={() => {}} />)
    const button = screen.getByRole('button', { name: 'Submit' })
    expect(button).not.toBeDisabled()
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })

  it('prevents default on mousedown so xterm keeps focus', () => {
    render(<AgentTerminalActions onSubmit={() => {}} />)
    const button = screen.getByRole('button', { name: 'Submit' })
    // Dispatch a real cancelable mousedown rather than relying on fireEvent's
    // return value: RTL's synthetic object does not reflect defaultPrevented
    // after React processes the handler in this environment.
    const mousedown = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    act(() => { button.dispatchEvent(mousedown) })
    expect(mousedown.defaultPrevented).toBe(true)
  })

  it('still lets mousedown bubble so the owning leaf engages the session', () => {
    const onMouseDown = vi.fn()
    render(
      <div onMouseDown={onMouseDown}>
        <AgentTerminalActions onSubmit={() => {}} />
      </div>,
    )
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Submit' }))
    expect(onMouseDown).toHaveBeenCalledTimes(1)
  })

  it('fires onSubmit once per click', () => {
    const onSubmit = vi.fn()
    render(<AgentTerminalActions onSubmit={onSubmit} />)
    const button = screen.getByRole('button', { name: 'Submit' })
    fireEvent.mouseDown(button)
    fireEvent.click(button)
    fireEvent.click(button)
    expect(onSubmit).toHaveBeenCalledTimes(2)
  })

  it('uses the composer control scaffold', () => {
    const { container } = render(<AgentTerminalActions onSubmit={() => {}} />)
    const button = screen.getByRole('button', { name: 'Submit' })
    expect(button.className).toContain('rounded-control')
    expect(button.className).toContain('control-active-bg')
    expect(container.firstElementChild!.className).toContain('border-t')
    expect(container.firstElementChild!.className).toContain('bg-surface')
  })
})