import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_SETTINGS } from '@renderer/app-state/settings/types'
import type { Settings } from '@renderer/app-state/settings/types'
import { CommandKeybindingsRow } from '@renderer/features/settings/ui/CommandKeybindingsRow'

// Settings › Command keybindings from the keyboard (ledger N15).
//
// A real settings store (a tiny zustand store holding the SHIPPED defaults),
// so a recorded chord really lands in overrides and the rows re-derive from
// it exactly as in the app. The catalogue is the real built-in command
// catalogue; nothing about the commands is stubbed.

const store = vi.hoisted(() => ({ current: null as null | { getState: () => unknown; setState: (s: unknown) => void } }))
vi.mock('@renderer/app-state/hooks', async () => {
  const { create } = await import('zustand')
  const { DEFAULT_SETTINGS: defaults } = await import('@renderer/app-state/settings/types')
  type State = { settings: Settings; installedExtensions: never[]; setSettings: (patch: Partial<Settings>) => void }
  const useStore = create<State>()(set => ({
    settings: { ...defaults },
    installedExtensions: [],
    setSettings: patch => set(state => ({ settings: { ...state.settings, ...patch } })),
  }))
  store.current = useStore as never
  return { useAppStore: useStore }
})

afterEach(() => {
  cleanup()
  act(() => store.current!.setState({ settings: { ...DEFAULT_SETTINGS } }))
})

/** The row for a command, found by its visible title (the row's first cell). */
function rowFor(title: string): HTMLElement {
  return screen.getByText(title, { selector: 'div.truncate' }).parentElement!
}

describe('CommandKeybindingsRow', () => {
  it('names every binding chip and action by its command', () => {
    render(<CommandKeybindingsRow />)
    const row = rowFor('New Tab')
    const chip = within(row).getByRole('button', { name: /^Remove ⌘T from New Tab$/ })
    // The chord is a Kbd chip (H1), not monospace text.
    expect(chip.querySelector('[data-slot="kbd"]')?.textContent).toBe('⌘T')
    expect(within(row).getByRole('button', { name: 'Add a shortcut to New Tab' })).toBeTruthy()
  })

  it('records a conflicting chord, focuses the fix, and returns focus to Add when it is cancelled', () => {
    render(<CommandKeybindingsRow />)
    const row = rowFor('New Tab')
    const add = within(row).getByRole('button', { name: 'Add a shortcut to New Tab' })
    fireEvent.click(add)
    expect(add).toHaveAttribute('aria-pressed', 'true')
    expect(add.querySelector('[data-slot="kbd"]')?.textContent).toBe('⎋')

    // ⌥D is Split Vertical's shipped binding and nothing reserves it, so the
    // banner offers Replace.
    fireEvent.keyDown(window, { key: '∂', code: 'KeyD', altKey: true })
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('already used by')
    // The user is on the keyboard: the first action has focus.
    expect(document.activeElement).toBe(within(alert).getByRole('button', { name: 'Replace' }))

    // Escape backs out of the conflict, and focus goes back where it came from.
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(document.activeElement).toBe(within(rowFor('New Tab')).getByRole('button', { name: 'Add a shortcut to New Tab' }))
  })

  it('focuses Cancel when a reserved owner leaves nothing to replace', () => {
    render(<CommandKeybindingsRow />)
    fireEvent.click(within(rowFor('New Tab')).getByRole('button', { name: 'Add a shortcut to New Tab' }))
    // ⌘W is held by the native menu and the editor: reserved, so no Replace.
    fireEvent.keyDown(window, { key: 'w', code: 'KeyW', metaKey: true })
    const alert = screen.getByRole('alert')
    expect(within(alert).queryByRole('button', { name: 'Replace' })).toBeNull()
    expect(document.activeElement).toBe(within(alert).getByRole('button', { name: /Cancel/ }))
  })
})
