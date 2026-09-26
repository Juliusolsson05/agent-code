import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
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
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)) })
    const field = screen.getByRole('combobox')
    const listbox = screen.getByRole('listbox')
    expect(field).toHaveAttribute('aria-expanded', 'true')
    expect(field).toHaveAttribute('aria-controls', listbox.id)
    expect(field.getAttribute('aria-activedescendant')).toBe(screen.getAllByRole('option')[0]!.id)
    fireEvent.keyDown(field, { key: 'ArrowDown' })
    expect(field.getAttribute('aria-activedescendant')).toBe(screen.getAllByRole('option')[1]!.id)
    // With suggestions showing, Tab still completes (default prevented).
    expect(fireEvent.keyDown(field, { key: 'Tab' })).toBe(false)
  })
})
