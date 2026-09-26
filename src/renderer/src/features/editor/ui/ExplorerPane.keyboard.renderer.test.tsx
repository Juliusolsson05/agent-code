import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ExplorerPane } from '@renderer/features/editor/ui/ExplorerPane'

// The Explorer's "+" (new file / folder) menu from the keyboard (K2-3).
// A keyboard-activated click carries clientX/Y 0, so the menu used to open at
// the window's top left corner, far from the button that opened it.

const originalApi = Object.getOwnPropertyDescriptor(window, 'api')
beforeEach(() => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: new Proxy({}, {
      get: (_target, key) => {
        if (key === 'editorListDirectory') return async () => ({ ok: true, entries: [] })
        if (String(key).startsWith('on')) return () => () => {}
        return vi.fn(async () => ({ ok: true }))
      },
    }),
  })
})
afterEach(() => {
  cleanup()
  if (originalApi) Object.defineProperty(window, 'api', originalApi)
  else Reflect.deleteProperty(window, 'api')
})

describe('Explorer new-item menu', () => {
  it('opens under its button when activated from the keyboard', async () => {
    render(<ExplorerPane root="/repo" activeFilePath={null} onOpenFile={async () => ({ ok: true as const })} />)
    const plus = screen.getByRole('button', { name: 'New file or folder' })
    plus.getBoundingClientRect = () => ({ left: 300, top: 40, right: 320, bottom: 60, width: 20, height: 20, x: 300, y: 40, toJSON: () => ({}) })
    // detail 0 is what the browser reports for an Enter/Space activation.
    await act(async () => { fireEvent.click(plus, { detail: 0, clientX: 0, clientY: 0 }) })
    const menu = screen.getByRole('menu', { name: 'Explorer actions' })
    expect(menu.style.left).toBe('300px')
    expect(menu.style.top).toBe('62px')
  })

  it('still opens at the pointer for a mouse click', async () => {
    render(<ExplorerPane root="/repo" activeFilePath={null} onOpenFile={async () => ({ ok: true as const })} />)
    const plus = screen.getByRole('button', { name: 'New file or folder' })
    await act(async () => { fireEvent.click(plus, { detail: 1, clientX: 210, clientY: 90 }) })
    const menu = screen.getByRole('menu', { name: 'Explorer actions' })
    expect(menu.style.left).toBe('210px')
    expect(menu.style.top).toBe('90px')
  })
})
