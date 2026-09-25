import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Workspace } from '@renderer/workspace/workspaceStore'

import { TabBar } from './TabBar'

// The window tab strip (plan N1): a tablist with roving focus — one Tab stop,
// ←/→ Home/End move and activate, Delete closes. It was a row of `div
// onClick`s with no role and no tab stop.

const originalApi = Object.getOwnPropertyDescriptor(window, 'api')
beforeEach(() => {
  Object.defineProperty(window, 'api', { configurable: true, value: { onTrafficLightInset: () => () => {} } })
})
afterEach(() => {
  cleanup()
  if (originalApi) Object.defineProperty(window, 'api', originalApi)
  else Reflect.deleteProperty(window, 'api')
})

function harness() {
  const activateTab = vi.fn()
  const closeTab = vi.fn(async () => undefined)
  const workspace = {
    state: {
      tabs: [{ id: 'a', title: 'app' }, { id: 'b', title: 'service' }, { id: 'c', title: 'docs' }],
      activeTabId: 'a',
      sessions: {},
      stage: { lanes: [], rows: [], focusedLane: 0 },
      pinnedSessionIds: [],
    },
    activateTab,
    closeTab,
  } as unknown as Workspace
  render(<TabBar workspace={workspace} onNewTabRequest={vi.fn()} />)
  return { activateTab, closeTab }
}

describe('TabBar keyboard', () => {
  it('is one Tab stop whose arrows activate the neighbouring tab', () => {
    const { activateTab } = harness()
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map(tab => tab.getAttribute('tabindex'))).toEqual(['0', '-1', '-1'])
    tabs[0]!.focus()
    fireEvent.keyDown(tabs[0]!, { key: 'ArrowRight' })
    expect(activateTab).toHaveBeenCalledWith('b')
    fireEvent.keyDown(tabs[0]!, { key: 'End' })
    expect(activateTab).toHaveBeenLastCalledWith('c')
    fireEvent.keyDown(tabs[0]!, { key: 'ArrowLeft' })
    expect(activateTab).toHaveBeenLastCalledWith('c') // wraps from the first
  })

  it('closes the focused tab with Delete and names each close button for its tab', () => {
    const { closeTab } = harness()
    const tabs = screen.getAllByRole('tab')
    fireEvent.keyDown(tabs[0]!, { key: 'Delete' })
    expect(closeTab).toHaveBeenCalledWith('a')
    expect(screen.getByRole('button', { name: 'Close service' })).toHaveAttribute('tabindex', '-1')
  })
})
