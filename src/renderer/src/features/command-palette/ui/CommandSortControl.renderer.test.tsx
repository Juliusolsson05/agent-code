import { fireEvent, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { CommandSortControl } from '@renderer/features/command-palette/ui/CommandSortControl'
import type { CommandSortMode } from '@renderer/features/command-palette/lib/sortCommands'

// WHY this file exists, against the plan's original judgement.
//
// The plan declined a renderer test here, reasoning that "a happy-dom test
// asserting that a menu opens on click would pin the implementation, not the
// contract." That was right about *opening* and wrong about *keys*, and review
// found the gap: the control's key handling was a React `onKeyDown` on its own
// root, which can never fire, because focus is deliberately kept in the palette's
// search input — a SIBLING of the control, not a descendant.
//
// The consequences were real contract violations, not implementation details:
// Escape closed the entire palette, and ↑/↓/Enter drove the command list hidden
// behind the open menu. So these tests reproduce the ACTUAL DOM relationship
// (input beside control, focus in the input) and assert on behavior a user can
// observe. They would all have failed against the first implementation.

/** The real header shape: the search input and the control are siblings, and an
 *  outer container stands in for the Dialog that would receive a leaked key. */
function Harness({
  mode = 'catalog',
  onChange = () => {},
  searching = false,
  onOuterKeyDown,
}: {
  mode?: CommandSortMode
  onChange?: (next: CommandSortMode) => void
  searching?: boolean
  onOuterKeyDown?: (event: React.KeyboardEvent) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <div onKeyDown={onOuterKeyDown}>
      <input ref={inputRef} data-testid="search" autoFocus />
      <CommandSortControl mode={mode} onChange={onChange} searching={searching} />
    </div>
  )
}

const openMenu = () => fireEvent.click(screen.getByRole('button', { name: /sort commands/i }))

describe('CommandSortControl keyboard contract', () => {
  it('closes on Escape typed in the search input, without letting it reach the dialog', () => {
    // The original bug: this key never reached the control, fell through to
    // Radix's document dismiss handler, and closed the whole palette while the
    // menu stayed mounted.
    const onOuterKeyDown = vi.fn()
    render(<Harness onOuterKeyDown={onOuterKeyDown} />)
    openMenu()
    expect(screen.getByRole('menu')).toBeTruthy()

    fireEvent.keyDown(screen.getByTestId('search'), { key: 'Escape' })

    expect(screen.queryByRole('menu')).toBeNull()
    expect(onOuterKeyDown).not.toHaveBeenCalled()
  })

  it('swallows ArrowDown/ArrowUp so they cannot drive the list behind the menu', () => {
    const onOuterKeyDown = vi.fn()
    render(<Harness onOuterKeyDown={onOuterKeyDown} />)
    openMenu()

    fireEvent.keyDown(screen.getByTestId('search'), { key: 'ArrowDown' })
    fireEvent.keyDown(screen.getByTestId('search'), { key: 'ArrowUp' })

    expect(onOuterKeyDown).not.toHaveBeenCalled()
    // Still open — arrows navigate the menu rather than dismissing it.
    expect(screen.getByRole('menu')).toBeTruthy()
  })

  it('commits the arrowed-to mode on Enter instead of running a palette command', () => {
    const onChange = vi.fn()
    const onOuterKeyDown = vi.fn()
    render(<Harness onChange={onChange} onOuterKeyDown={onOuterKeyDown} />)
    openMenu()

    // Opens on the active mode ('catalog', index 0); one step down is 'alpha'.
    fireEvent.keyDown(screen.getByTestId('search'), { key: 'ArrowDown' })
    fireEvent.keyDown(screen.getByTestId('search'), { key: 'Enter' })

    expect(onChange).toHaveBeenCalledWith('alpha')
    expect(onOuterKeyDown).not.toHaveBeenCalled()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('leaves keys alone once closed, so the palette keeps working normally', () => {
    // The mirror of the tests above, and the one that would catch an
    // over-aggressive fix: the capture listener must be torn down on close, or
    // the palette's own arrows and Enter would be dead for the rest of the
    // session.
    const onOuterKeyDown = vi.fn()
    render(<Harness onOuterKeyDown={onOuterKeyDown} />)
    openMenu()
    fireEvent.keyDown(screen.getByTestId('search'), { key: 'Escape' })

    fireEvent.keyDown(screen.getByTestId('search'), { key: 'ArrowDown' })
    fireEvent.keyDown(screen.getByTestId('search'), { key: 'Enter' })

    expect(onOuterKeyDown).toHaveBeenCalledTimes(2)
  })

  it('opens the keyboard cursor on the ACTIVE mode, not the top of the list', () => {
    const onChange = vi.fn()
    render(<Harness mode="grouped" onChange={onChange} />)
    openMenu()

    // 'grouped' is index 2; Enter with no arrowing re-selects it rather than
    // silently jumping the user to 'catalog'.
    fireEvent.keyDown(screen.getByTestId('search'), { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('grouped')
  })

  it('reports relevance and refuses to open while a query is present', () => {
    render(<Harness searching />)
    const button = screen.getByRole('button', { name: /relevance/i })

    expect(button.hasAttribute('disabled')).toBe(true)
    fireEvent.click(button)
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
