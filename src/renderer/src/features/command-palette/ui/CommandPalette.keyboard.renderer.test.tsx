import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useAppStore } from '@renderer/app-state/hooks'
import { emptyRuntime } from '@renderer/session-runtime/state'
import { loadRecordedDispatchWorkspace } from '@renderer/workspace/testing/recordedDispatchWorkspace'
import { WorkspaceProvider } from '@renderer/workspace/WorkspaceContext'
import type { Workspace } from '@renderer/workspace/workspaceStore'

import { CommandPalette } from './CommandPalette'

// The command palette's keyboard contract (plan S43): the search box is a
// combobox that names the highlighted row, rows are options, ⌃N/⌃P and
// PageDown move like every list, shortcuts render as the shared chip, and the
// keys are shown in a legend strip. Mounted for real against the recorded
// dispatch workspace fixture.

const originalApi = Object.getOwnPropertyDescriptor(window, 'api')
afterEach(() => {
  cleanup()
  act(() => { useAppStore.setState({ commandPaletteOpen: false }) })
  if (originalApi) Object.defineProperty(window, 'api', originalApi)
  else Reflect.deleteProperty(window, 'api')
})

function mount() {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: new Proxy({}, {
      get: (_target, key) => (String(key).startsWith('on') ? () => () => {} : vi.fn(async () => undefined)),
    }),
  })
  // The recorded fixture carries real STATE; the palette only reads a few
  // workspace methods while rendering. A plain object (the palette spreads
  // the workspace into its command context, which a Proxy would not survive).
  const recorded = loadRecordedDispatchWorkspace()
  const workspace = { ...recorded, runtimes: {}, getRuntime: () => emptyRuntime() } as unknown as Workspace
  act(() => { useAppStore.setState({ commandPaletteOpen: true }) })
  render(<WorkspaceProvider workspace={workspace}><CommandPalette /></WorkspaceProvider>)
  return screen.getByRole('combobox', { name: 'Command palette search' })
}

describe('Command palette keyboard', () => {
  it('names the highlighted row from the search box and moves with ⌃N / PageDown', () => {
    const input = mount()
    expect(input).toHaveAttribute('aria-activedescendant', 'palette-row-0')
    expect(document.getElementById('palette-row-0')).toHaveAttribute('role', 'option')
    fireEvent.keyDown(input, { key: 'n', ctrlKey: true })
    expect(input).toHaveAttribute('aria-activedescendant', 'palette-row-1')
    fireEvent.keyDown(input, { key: 'PageDown' })
    expect(input).toHaveAttribute('aria-activedescendant', 'palette-row-11')
    fireEvent.keyDown(input, { key: 'p', ctrlKey: true })
    expect(input).toHaveAttribute('aria-activedescendant', 'palette-row-10')
  })

  it('draws the highlight with the app selected-row look, and keeps the rail slot on other rows (T7, G-8)', () => {
    // The palette is the most-used list; it had the selected fill without the
    // accent rail every other list uses. Unselected rows keep a transparent
    // 2px rail so moving the highlight never shifts the text.
    mount()
    const selected = document.getElementById('palette-row-0')!
    const other = document.getElementById('palette-row-1')!
    expect(selected.className).toMatch(/\bborder-l-accent\b/)
    expect(selected.className).toMatch(/\bbg-row-selected-bg\b/)
    expect(other.className).toMatch(/\bborder-l-2\b/)
    expect(other.className).toMatch(/\bborder-l-transparent\b/)
  })

  it('shows shortcuts as the shared chip and the palette keys in a legend', () => {
    mount()
    const list = screen.getByRole('listbox', { name: 'Commands' })
    expect(list.querySelector('[data-slot="kbd"]')).not.toBeNull()
    expect(document.querySelector('[data-slot="kbd-legend"]')).not.toBeNull()
    expect(screen.getByText('run')).toBeInTheDocument()
  })
})
