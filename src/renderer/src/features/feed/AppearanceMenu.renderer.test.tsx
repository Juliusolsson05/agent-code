import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { DEFAULT_SETTINGS } from '@renderer/app-state/settings/types'

import { AppearanceMenu } from './AppearanceMenu'

// The Appearance menu (status bar eye) used to be a hand-rolled div that
// never took focus: Enter opened it and Tab walked past it into the page.
// These pin the keyboard contract it has now (plan M1).

describe('AppearanceMenu', () => {
  it('opens from the keyboard with focus inside, and picks a mode without closing', async () => {
    const onChange = vi.fn()
    render(<AppearanceMenu settings={DEFAULT_SETTINGS} onChange={onChange} />)
    const trigger = screen.getByRole('button', { name: 'Appearance' })
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'Enter' })
    const menu = await screen.findByRole('menu')
    await waitFor(() => expect(menu.contains(document.activeElement)).toBe(true))

    const radios = screen.getAllByRole('menuitemradio')
    const other = radios.find(item => item.getAttribute('aria-checked') === 'false')!
    fireEvent.keyDown(other, { key: 'Enter' })
    await waitFor(() => expect(onChange).toHaveBeenCalled())
    // A live preview: the menu stays open so the next theme can be tried.
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })

  it('names every accent swatch for assistive tech and typeahead', async () => {
    render(<AppearanceMenu settings={DEFAULT_SETTINGS} onChange={() => {}} />)
    const trigger = screen.getByRole('button', { name: 'Appearance' })
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'Enter' })
    await screen.findByRole('menu')
    for (const item of screen.getAllByRole('menuitemradio')) {
      expect(item).toHaveAccessibleName()
    }
  })

  it('closes on Escape and returns focus to the eye button', async () => {
    render(<AppearanceMenu settings={DEFAULT_SETTINGS} onChange={() => {}} />)
    const trigger = screen.getByRole('button', { name: 'Appearance' })
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'Enter' })
    await screen.findByRole('menu')
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })
})
