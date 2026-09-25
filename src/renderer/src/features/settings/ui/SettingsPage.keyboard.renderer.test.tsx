import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_SETTINGS } from '@renderer/app-state/settings/types'
import type { SettingActionContext, SettingDefinition } from '@renderer/features/settings/lib/settingsRegistry'
import type { Workspace } from '@renderer/workspace/workspaceStore'

import { SettingsList } from './SettingsList'
import { SettingsPage } from './SettingsPage'
import { SettingsSidebar } from './SettingsSidebar'

// Settings keyboard contract (plan S45/N14): categories are a one-Tab-stop
// tablist whose arrows select; ⌘[ / ⌘] step categories from anywhere;
// toggles are switches; select rows are radio groups whose arrows MOVE focus
// without choosing (the settings apply live). The sidebar and list are
// rendered directly: the full page mounts every heavy row (skills, themes,
// devices), which is not what these contracts are about.

const originalApi = Object.getOwnPropertyDescriptor(window, 'api')
beforeEach(() => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: new Proxy({}, {
      get: (_target, key) => (String(key).startsWith('on') ? () => () => {} : vi.fn(async () => undefined)),
    }),
  })
})
afterEach(() => {
  cleanup()
  if (originalApi) Object.defineProperty(window, 'api', originalApi)
  else Reflect.deleteProperty(window, 'api')
})

describe('Settings keyboard', () => {
  it('makes categories one Tab stop whose arrows select and focus the next category', () => {
    const onSelectCategory = vi.fn()
    const { rerender } = render(<SettingsSidebar selectedCategory="all" onSelectCategory={onSelectCategory} counts={{}} />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs.filter(tab => tab.getAttribute('tabindex') === '0')).toEqual([tabs[0]])
    tabs[0]!.focus()
    fireEvent.keyDown(tabs[0]!, { key: 'ArrowDown' })
    expect(onSelectCategory).toHaveBeenCalledWith(tabs[1]!.getAttribute('data-category'))
    rerender(<SettingsSidebar selectedCategory="all" onSelectCategory={onSelectCategory} counts={{}} />)
    fireEvent.keyDown(tabs[0]!, { key: 'End' })
    expect(onSelectCategory).toHaveBeenLastCalledWith(tabs[tabs.length - 1]!.getAttribute('data-category'))
  })

  it('steps categories with ⌘] from the search box, and labels Close ⎋', () => {
    render(
      <SettingsPage
        onClose={vi.fn()}
        workspace={{ state: { sessions: {}, tabs: [], activeTabId: '' } } as unknown as Workspace}
        settings={DEFAULT_SETTINGS}
        onChange={vi.fn()}
        onReset={vi.fn()}
      />,
    )
    const search = screen.getAllByRole('textbox')[0]!
    // Filter to nothing first, so no heavy row mounts as categories change.
    fireEvent.change(search, { target: { value: 'zz-no-such-setting-zz' } })
    fireEvent.keyDown(search, { key: ']', code: 'BracketRight', metaKey: true })
    expect(screen.getAllByRole('tab')[1]).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('button', { name: 'Close' }).querySelector('[data-slot="kbd"]')?.textContent).toBe('⎋')
  })

  it('renders toggles as switches and a select as a radio group whose arrows move without choosing', () => {
    const onToggle = vi.fn()
    const onSelect = vi.fn()
    const definitions = [
      { id: 't', category: 'appearance', title: 'Toggle me', description: '', keywords: [], control: { type: 'toggle', getValue: () => true, onToggle } },
      { id: 's', category: 'appearance', title: 'Pick one', description: '', keywords: [], control: { type: 'select', getValue: () => 'b', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }, { value: 'c', label: 'C' }], onSelect } },
    ] as unknown as SettingDefinition[]
    render(<SettingsList definitions={definitions} settings={DEFAULT_SETTINGS} selectedCategory="all" actionContext={{} as SettingActionContext} />)
    expect(screen.getByRole('switch', { name: 'Toggle me' })).toHaveAttribute('aria-checked', 'true')
    const group = screen.getByRole('radiogroup', { name: 'Pick one' })
    const [a, b, c] = within(group).getAllByRole('radio')
    expect([a, b, c].map(radio => radio!.getAttribute('tabindex'))).toEqual(['-1', '0', '-1'])
    b!.focus()
    fireEvent.keyDown(b!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(c)
    expect(onSelect).not.toHaveBeenCalled()
    fireEvent.click(c!)
    expect(onSelect).toHaveBeenCalledWith(expect.anything(), 'c')
  })
})
