import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAppStore } from '@renderer/app-state/store'
import type { SidekickActions } from '@renderer/features/sidekick/actions/useSidekickActions'
import { useSidekickIndexStore } from '@renderer/features/sidekick/state/sidekickIndexStore'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import type { SidekickIndexView, SidekickSummary } from '@shared/sidekicks/types'

import { SidekickPanel } from './SidekickPanel'
import { scrubbedPanelPointer } from './SidekickPanelSurface'

// The mounted Sidekick panel (#1493, review round 1 F2/F3/F6). The leaf is the
// one stand-in: renderWorkspaceLeaf draws a whole TileLeaf, whose own focus
// and input behaviour has its own tests; here it is a textarea, which is all
// the panel's focus rule looks for. Hermes connections are irrelevant to a
// Claude sidekick and would need the IPC subscription.
vi.mock('@renderer/workspace/tile-tree/TileTree', () => ({
  renderWorkspaceLeaf: (sessionId: string) => <textarea aria-label={`leaf ${sessionId}`} />,
}))
vi.mock('@renderer/features/hermes-chat/useHermesConnections', () => ({ useHermesConnections: () => null }))

const ID = '00000000-0000-4000-8000-000000000001'
const HOME = '/home/recorded'
const original = useAppStore.getState()

function summary(liveWindowId: string | null): SidekickSummary {
  return { id: ID, sessionId: 'sk', kind: 'claude', providerRuntime: null, title: null, agentNameId: null, remoteConnectionId: null, createdAt: 1, lastActiveAt: 1, liveWindowId }
}
function view(sidekicks: SidekickSummary[], revision = 1): SidekickIndexView {
  return { revision, homeDir: HOME, sidekicks }
}

function workspaceWith(sessions: Workspace['state']['sessions']): Workspace {
  return {
    state: { ...original.workspaceState, sessions, sidekickPanel: { open: true, width: 420, sidekickId: ID } },
    restoreStatus: 'restored',
    setSidekickPanel: vi.fn(),
    reloadSessionAgent: vi.fn(),
  } as unknown as Workspace
}

function actionsWith(showSidekick: SidekickActions['showSidekick']): SidekickActions {
  return { showSidekick, createSidekick: vi.fn(), openHere: vi.fn(), removeSidekick: vi.fn(), onReleased: vi.fn() } as unknown as SidekickActions
}

beforeEach(() => {
  useSidekickIndexStore.setState({ view: null })
})
afterEach(() => {
  useAppStore.setState(original, true)
  useSidekickIndexStore.setState({ view: null })
  document.body.replaceChildren()
})

describe('Sidekick panel', () => {
  it('asks main to attach a sidekick the index calls live elsewhere, and shows "elsewhere" when main says so (F3)', async () => {
    // After this window's renderer reloads, main still files the lease under
    // this window at the old generation; only main can tell that from a
    // sidekick really open elsewhere.
    useSidekickIndexStore.getState().accept(view([summary('this-window-before-reload')]))
    const showSidekick = vi.fn(async () => ({ ok: false as const, reason: 'owned-elsewhere' as const }))
    render(<SidekickPanel workspace={workspaceWith({})} actions={actionsWith(showSidekick)} />)
    await waitFor(() => expect(screen.getByText('Live in another window.')).toBeTruthy())
    expect(showSidekick).toHaveBeenCalledWith(ID)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('Retry attaches again (F6)', async () => {
    useSidekickIndexStore.getState().accept(view([summary(null)]))
    const showSidekick = vi.fn(async () => ({ ok: false as const, reason: 'window-gone' as const }))
    render(<SidekickPanel workspace={workspaceWith({})} actions={actionsWith(showSidekick)} />)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('This window could not take the sidekick.'))
    expect(showSidekick).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(showSidekick).toHaveBeenCalledTimes(2))
  })

  it('moves the caret into the sidekick when it owns the keyboard, even if mounted already focused (F2)', async () => {
    // The first ⌘J mounts the leaf with region 'sidekick' already set, so
    // TileLeaf's own "focus changed" rule never fires and the caret stayed in
    // the lane's composer — Enter submitted there.
    useSidekickIndexStore.getState().accept(view([summary('this-window')]))
    const lane = document.createElement('textarea')
    document.body.append(lane)
    lane.focus()
    act(() => { useAppStore.getState().setKeyboardRegion('sidekick') })
    render(<SidekickPanel workspace={workspaceWith({ sk: { kind: 'claude', cwd: HOME, sidekickId: ID } })} actions={actionsWith(vi.fn())} />)
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('leaf sk')))
  })
})

describe('panel pointer scrub (F4)', () => {
  const older = { ...summary(null), id: '00000000-0000-4000-8000-000000000002', lastActiveAt: 5 }
  const newer = { ...summary(null), id: '00000000-0000-4000-8000-000000000003', lastActiveAt: 9 }

  it('moves a pointer the index no longer lists to the most recently active sidekick, or clears it', () => {
    expect(scrubbedPanelPointer(view([older, newer]), ID, false)).toBe(newer.id)
    expect(scrubbedPanelPointer(view([]), ID, false)).toBeNull()
  })

  it('keeps the pointer before the index loads, while it is listed, and while this window holds the row', () => {
    expect(scrubbedPanelPointer(null, ID, false)).toBe(ID)
    expect(scrubbedPanelPointer(view([summary(null)]), ID, false)).toBe(ID)
    // The index broadcast can trail this window's own register by a tick.
    expect(scrubbedPanelPointer(view([]), ID, true)).toBe(ID)
  })
})
