import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, onTestFinished, vi } from 'vitest'

import { useListNavigation, type UseListNavigationOptions } from './useListNavigation'

// Drives the hook through a real rendered list with real key events, the way
// every list dialog uses it: DOM focus on a filter input (or the list
// surface), rows are non-tabbable buttons, the highlight is an index exposed
// via aria-activedescendant. The contracts pinned here are the ones the 27
// hand-rolled implementations disagreed on (see the hook's header).

const ROWS = ['alpha', 'beta', 'gamma', 'delta', 'epsilon']

function Harness(props: Partial<UseListNavigationOptions> & { withInput?: boolean; rows?: string[]; keyed?: boolean }) {
  const rows = props.rows ?? ROWS
  const nav = useListNavigation({ count: rows.length, idPrefix: 'row', keys: props.keyed ? rows : undefined, ...props })
  const Focus = props.withInput === false ? 'div' : 'input'
  return (
    <div>
      <Focus
        data-testid="focus"
        tabIndex={0}
        aria-activedescendant={nav.activeId}
        onKeyDown={event => {
          nav.onKeyDown(event)
        }}
      />
      <button type="button">Cancel</button>
      <div role="listbox">
        {rows.map((row, index) => (
          <button key={row} type="button" role="option" tabIndex={-1} aria-selected={index === nav.index} {...nav.getItemProps(index)}>
            {row}
          </button>
        ))}
      </div>
    </div>
  )
}

const highlighted = () => screen.getByRole('option', { selected: true }).textContent
const press = (key: string, init: Record<string, unknown> = {}) =>
  fireEvent.keyDown(screen.getByTestId('focus'), { key, ...init })

describe('useListNavigation', () => {
  it('moves with arrows and clamps at both ends (lists do not wrap)', () => {
    render(<Harness />)
    press('ArrowUp')
    expect(highlighted()).toBe('alpha')
    for (let i = 0; i < 10; i += 1) press('ArrowDown')
    expect(highlighted()).toBe('epsilon')
  })

  it('wraps when asked to (menus)', () => {
    render(<Harness loop />)
    press('ArrowUp')
    expect(highlighted()).toBe('epsilon')
  })

  it('accepts ⌃N/⌃P but never takes ⌘N', () => {
    render(<Harness />)
    press('n', { ctrlKey: true })
    expect(highlighted()).toBe('beta')
    press('p', { ctrlKey: true })
    expect(highlighted()).toBe('alpha')
    expect(press('n', { metaKey: true })).toBe(true) // not prevented: New Agent keeps it
    expect(highlighted()).toBe('alpha')
  })

  it('pages by pageSize with PageUp/PageDown', () => {
    render(<Harness pageSize={2} />)
    press('PageDown')
    expect(highlighted()).toBe('gamma')
    press('PageUp')
    expect(highlighted()).toBe('alpha')
  })

  it('leaves Home/End to the caret in a text field, and takes them on the list surface', () => {
    const { unmount } = render(<Harness />)
    expect(press('End')).toBe(true) // default not prevented: caret moves
    expect(highlighted()).toBe('alpha')
    unmount()
    render(<Harness withInput={false} />)
    press('End')
    expect(highlighted()).toBe('epsilon')
    press('Home')
    expect(highlighted()).toBe('alpha')
  })

  it('takes j/k only when enabled and never from a text field', () => {
    const { unmount } = render(<Harness jk />)
    press('j')
    expect(highlighted()).toBe('alpha') // typed into the filter
    unmount()
    render(<Harness jk withInput={false} />)
    press('j')
    expect(highlighted()).toBe('beta')
    press('k')
    expect(highlighted()).toBe('alpha')
  })

  it('skips disabled rows', () => {
    render(<Harness isDisabled={index => index === 1} />)
    press('ArrowDown')
    expect(highlighted()).toBe('gamma')
  })

  it('activates the highlight on Enter, but a focused button keeps its own Enter', () => {
    const onActivate = vi.fn()
    render(<Harness onActivate={onActivate} />)
    press('ArrowDown')
    press('Enter')
    expect(onActivate).toHaveBeenCalledWith(1)

    onActivate.mockClear()
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    // Rendered outside the focus element here, so dispatch at it directly to
    // prove the hook's own guard (the list dialogs put Cancel inside).
    const handled = fireEvent.keyDown(cancel, { key: 'Enter' })
    expect(handled).toBe(true)
    expect(onActivate).not.toHaveBeenCalled()
  })

  it('toggles on Space when the list is multi-select, and leaves Space to a text field otherwise', () => {
    const onToggle = vi.fn()
    render(<Harness onToggle={onToggle} withInput={false} />)
    press(' ')
    expect(onToggle).toHaveBeenCalledWith(0)
  })

  it('follows the mouse only when it actually moves, and does not steal focus on click', () => {
    const onActivate = vi.fn()
    render(<Harness onActivate={onActivate} />)
    const gamma = screen.getByRole('option', { name: 'gamma' })
    fireEvent.mouseMove(gamma)
    expect(highlighted()).toBe('gamma')
    // mousedown default prevented = focus stays on the input.
    expect(fireEvent.mouseDown(gamma)).toBe(false)
    fireEvent.click(gamma)
    expect(onActivate).toHaveBeenCalledWith(2)
  })

  it('scrolls the keyboard highlight into view, but never on hover', () => {
    const scroll = vi.fn()
    const original = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = scroll
    onTestFinished(() => {
      Element.prototype.scrollIntoView = original
    })
    render(<Harness />)
    press('ArrowDown')
    expect(scroll).toHaveBeenCalledWith({ block: 'nearest' })
    scroll.mockClear()
    fireEvent.mouseMove(screen.getByRole('option', { name: 'delta' }))
    expect(scroll).not.toHaveBeenCalled()
  })

  it('exposes the highlighted row id for aria-activedescendant', () => {
    render(<Harness />)
    press('ArrowDown')
    expect(screen.getByTestId('focus')).toHaveAttribute('aria-activedescendant', 'row-1')
  })

  it('clamps the highlight when the list shrinks under it', () => {
    const { rerender } = render(<Harness />)
    press('End', {}) // text field: no-op
    for (let i = 0; i < 4; i += 1) press('ArrowDown')
    rerender(<Harness rows={['alpha', 'beta']} />)
    expect(highlighted()).toBe('beta')
  })

  it('keeps the highlight on the same ITEM when a row above it vanishes from a keyed live list', () => {
    // New Agent In's failure mode: a project tab closes while the dialog is
    // open, the list shifts up by one, and a positional highlight lands on the
    // NEXT project — Enter then spawns an agent somewhere never highlighted.
    const { rerender } = render(<Harness keyed />)
    press('ArrowDown')
    press('ArrowDown')
    expect(highlighted()).toBe('gamma')
    rerender(<Harness keyed rows={['beta', 'gamma', 'delta', 'epsilon']} />)
    expect(highlighted()).toBe('gamma')
  })

  it('is positional without keys, which is right for a static list', () => {
    const { rerender } = render(<Harness />)
    press('ArrowDown')
    press('ArrowDown')
    rerender(<Harness rows={['beta', 'gamma', 'delta', 'epsilon']} />)
    expect(highlighted()).toBe('delta')
  })
})
