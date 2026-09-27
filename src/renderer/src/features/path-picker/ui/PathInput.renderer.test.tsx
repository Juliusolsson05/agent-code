import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PathInput } from './PathInput'

// The path field's suggestion dropdown (plan M5): a combobox that names the
// highlighted suggestion (the dropdown had no roles, so the highlight was
// never announced), with Tab completing only while suggestions show (k7).

const originalApi = Object.getOwnPropertyDescriptor(window, 'api')
afterEach(() => {
  cleanup()
  if (originalApi) Object.defineProperty(window, 'api', originalApi)
  else Reflect.deleteProperty(window, 'api')
})

function Harness() {
  const [value, setValue] = useState('/repo/')
  return <PathInput value={value} onChange={setValue} onSubmit={() => {}} onCancel={() => {}} autoFocus />
}

describe('PathInput', () => {
  it('announces the highlighted suggestion from the field and moves it with ↓', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        listDirectory: vi.fn(async () => ({ ok: true, entries: [
          { name: 'alpha', isDirectory: true }, { name: 'beta', isDirectory: true },
        ] })),
      },
    })
    render(<Harness />)
    // Wait for the suggestions themselves, not a 100 ms guess (#1107, review of #1377): the lookup
    // runs after a 60 ms debounce, so a loaded runner could still be before it when a fixed sleep
    // ended. findByRole polls until the listbox exists.
    const listbox = await screen.findByRole('listbox')
    const field = screen.getByRole('combobox')
    expect(field).toHaveAttribute('aria-expanded', 'true')
    expect(field).toHaveAttribute('aria-controls', listbox.id)
    expect(field.getAttribute('aria-activedescendant')).toBe(screen.getAllByRole('option')[0]!.id)
    fireEvent.keyDown(field, { key: 'ArrowDown' })
    expect(field.getAttribute('aria-activedescendant')).toBe(screen.getAllByRole('option')[1]!.id)
    // With suggestions showing, Tab still completes (default prevented).
    expect(fireEvent.keyDown(field, { key: 'Tab' })).toBe(false)
  })
})
