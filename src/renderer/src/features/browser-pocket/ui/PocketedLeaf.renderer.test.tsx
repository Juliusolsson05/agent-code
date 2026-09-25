import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAppStore } from '@renderer/app-state/hooks'
import type { Workspace } from '@renderer/workspace/workspaceStore'

import { usePlacementStore } from '../placement/placementStore'
import { PocketedLeaf } from './PocketedLeaf'

const original = useAppStore.getState()
beforeEach(() => {
  useAppStore.setState({ settings: { ...original.settings, browserPocketEnabled: true } })
  window.api = { ...(window.api ?? {}), pocketThumbnail: async () => null, takeOverPocket: async () => {}, resumePocketAgent: async () => {} } as unknown as typeof window.api
})
afterEach(() => { vi.restoreAllMocks(); cleanup(); useAppStore.setState(original, true); usePlacementStore.setState({ slots: {} }) })

const ws = (pocket?: object): Workspace => ({
  state: { sessions: { s1: { cwd: '/w', kind: 'claude', ...(pocket ? { browserPocket: pocket } : {}) } } },
  runtimes: {},
  updateBrowserPocket: () => {},
} as unknown as Workspace)

describe('PocketedLeaf', () => {
  it('a collapsed pocket in a lane is the strip, never a slot (no page is placed)', () => {
    render(<PocketedLeaf sessionId={'s1' as never} workspace={ws({ pocketId: 'p1', view: 'collapsed', profile: 'lane', url: 'http://localhost:5173/' })} placement={{ surface: 'lane', laneIndex: 0, focused: true, dimmed: false }}><div>agent</div></PocketedLeaf>)
    expect(screen.getByText('agent')).toBeTruthy()
    expect(screen.getByTestId('pocket-strip')).toBeTruthy()
    expect(screen.queryByTestId('pocket-slot')).toBeNull()
  })

  it('Spotlight splits and registers a spotlight slot for the SAME pocketId the lane uses', () => {
    render(<PocketedLeaf sessionId={'s1' as never} workspace={ws({ pocketId: 'p1', view: 'open', profile: 'lane' })} placement={{ surface: 'spotlight', laneIndex: null, focused: true, dimmed: false }}><div>agent</div></PocketedLeaf>)
    expect(screen.getByTestId('pocket-slot').getAttribute('data-surface')).toBe('spotlight')
    expect(Object.keys(usePlacementStore.getState().slots.p1 ?? {})).toEqual(['spotlight'])
  })

  it('an open pocket with no page yet shows this lane\'s empty state inside the slot', () => {
    render(<PocketedLeaf sessionId={'s1' as never} workspace={ws({ pocketId: 'p1', view: 'open', profile: 'lane' })} placement={{ surface: 'spotlight', laneIndex: null, focused: true, dimmed: false }}><div>agent</div></PocketedLeaf>)
    expect(screen.getByRole('heading', { name: 'Open a page' })).toBeTruthy()
  })

  it('renders only the agent when the feature is off, even if the session has a pocket', () => {
    useAppStore.setState({ settings: { ...original.settings, browserPocketEnabled: false } })
    render(<PocketedLeaf sessionId={'s1' as never} workspace={ws({ pocketId: 'p1', view: 'open', profile: 'lane' })} placement={{ surface: 'spotlight', laneIndex: null, focused: true, dimmed: false }}><div>agent</div></PocketedLeaf>)
    expect(screen.getByText('agent')).toBeTruthy()
    expect(screen.queryByTestId('pocket-slot')).toBeNull()
    expect(screen.queryByTestId('pocket-strip')).toBeNull()
  })
})

it('attaching and detaching a pocket never remounts the agent view (review B #4)', () => {
  // The terminal attach and feed live in the leaf; a remount tears them down.
  let mounts = 0
  function Agent() {
    const [id] = useState(() => { mounts++; return mounts })
    return <div>agent #{id}</div>
  }
  const placement = { surface: 'lane' as const, laneIndex: 0, focused: true, dimmed: false }
  const view = render(<PocketedLeaf sessionId={'s1' as never} workspace={ws()} placement={placement}><Agent /></PocketedLeaf>)
  view.rerender(<PocketedLeaf sessionId={'s1' as never} workspace={ws({ pocketId: 'p1', view: 'open', profile: 'lane' })} placement={placement}><Agent /></PocketedLeaf>)
  view.rerender(<PocketedLeaf sessionId={'s1' as never} workspace={ws()} placement={placement}><Agent /></PocketedLeaf>)
  expect(mounts).toBe(1)
})

it('opens a 240px lane at full size and returns to the same mounted agent without detaching', () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 240, height: 350, x: 0, y: 0, top: 0, left: 0, right: 240, bottom: 350, toJSON: () => ({}) })
  let mounts = 0
  function Agent() { useState(() => { mounts++; return 0 }); return <div>kept agent</div> }
  function Harness() {
    const [state, setState] = useState(ws({ pocketId: 'p1', profile: 'lane', view: 'collapsed' }).state)
    const workspace = { ...ws(), state, updateBrowserPocket: setState } as Workspace
    return <PocketedLeaf sessionId={'s1' as never} workspace={workspace} placement={{ surface: 'lane', laneIndex: 0, focused: true, dimmed: false }}><Agent /></PocketedLeaf>
  }
  render(<Harness />)
  fireEvent.click(screen.getByRole('button', { name: 'Open browser pocket' }))
  expect(screen.getByTestId('pocket-slot')).toBeTruthy()
  expect(screen.queryByRole('separator')).toBeNull()
  expect(screen.getByText('kept agent').closest('[style]')?.getAttribute('style')).toContain('display: none')
  fireEvent.click(screen.getByRole('button', { name: 'Show agent' }))
  expect(screen.getByTestId('pocket-strip')).toBeTruthy()
  expect(mounts).toBe(1)
})

it('bounds keyboard resizing and releases guest hit testing when a drag is cancelled', () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 800, height: 500, x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 500, toJSON: () => ({}) })
  const workspace = ws({ pocketId: 'p1', profile: 'lane', view: 'open' })
  workspace.updateBrowserPocket = vi.fn()
  render(<PocketedLeaf sessionId={'s1' as never} workspace={workspace} placement={{ surface: 'lane', laneIndex: 0, focused: true, dimmed: false }}><div>agent</div></PocketedLeaf>)
  const separator = screen.getByRole('separator')
  fireEvent.keyDown(separator, { key: 'ArrowLeft' })
  expect(workspace.updateBrowserPocket).toHaveBeenCalledOnce()
  fireEvent.pointerDown(separator, { button: 0 })
  expect(document.documentElement.classList.contains('pocket-dragging')).toBe(true)
  fireEvent(window, new Event('pointercancel'))
  expect(document.documentElement.classList.contains('pocket-dragging')).toBe(false)
})

it('expands a cramped browser beside its agent in Spotlight', () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 240, height: 350 } as DOMRect)
  const workspace = ws({ pocketId: 'p1', profile: 'lane', view: 'open' })
  workspace.setSpotlightTarget = vi.fn()
  render(<PocketedLeaf sessionId={'s1' as never} workspace={workspace} placement={{ surface: 'lane', laneIndex: 0, focused: true, dimmed: false }}><div>agent</div></PocketedLeaf>)
  fireEvent.click(screen.getByRole('button', { name: 'Expand browser beside agent' }))
  expect(workspace.setSpotlightTarget).toHaveBeenCalledWith('s1')
})
