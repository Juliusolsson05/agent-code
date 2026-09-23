import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { useAppStore } from '@renderer/app-state/hooks'
import type { Workspace } from '@renderer/workspace/workspaceStore'

import { usePlacementStore } from '../placement/placementStore'
import { PocketedLeaf } from './PocketedLeaf'

const original = useAppStore.getState()
beforeEach(() => {
  useAppStore.setState({ settings: { ...original.settings, browserPocketEnabled: true } })
  window.api = { ...(window.api ?? {}), pocketThumbnail: async () => null, takeOverPocket: async () => {}, resumePocketAgent: async () => {} } as unknown as typeof window.api
})
afterEach(() => { cleanup(); useAppStore.setState(original, true); usePlacementStore.setState({ slots: {} }) })

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
    expect(screen.getByText(/Nothing in this lane is serving a page yet/)).toBeTruthy()
  })

  it('renders only the agent when the feature is off, even if the session has a pocket', () => {
    useAppStore.setState({ settings: { ...original.settings, browserPocketEnabled: false } })
    render(<PocketedLeaf sessionId={'s1' as never} workspace={ws({ pocketId: 'p1', view: 'open', profile: 'lane' })} placement={{ surface: 'spotlight', laneIndex: null, focused: true, dimmed: false }}><div>agent</div></PocketedLeaf>)
    expect(screen.getByText('agent')).toBeTruthy()
    expect(screen.queryByTestId('pocket-slot')).toBeNull()
    expect(screen.queryByTestId('pocket-strip')).toBeNull()
  })
})
