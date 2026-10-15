import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAppStore } from '@renderer/app-state/store'
import type { SidekickActions } from '@renderer/features/sidekick/actions/useSidekickActions'
import { useSidekickIndexStore } from '@renderer/features/sidekick/state/sidekickIndexStore'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import type { SidekickIndexView, SidekickSummary } from '@shared/sidekicks/types'

import { SidekickPanel } from './SidekickPanel'
import { scrubbedPanelPointer, SidekickPanelSurface } from './SidekickPanelSurface'
import { useKeyboardRegionFollowsPointer } from './KeyboardRegionContext'
import { spotlightCommands } from '@renderer/features/spotlight/commands/spotlightCommands'
import { sidekickSpotlightActive } from '@renderer/features/sidekick/state/sidekickSpotlight'

// The mounted Sidekick panel (#1493, review round 1 F2/F3/F6). The leaf is the
// one stand-in: renderWorkspaceLeaf draws a whole TileLeaf, whose own focus
// and input behaviour has its own tests; here it is a textarea, which is all
// the panel's focus rule looks for. Hermes connections are irrelevant to a
// Claude sidekick and would need the IPC subscription.
// The stand-in is shaped like the real TileLeaf where focus is concerned (the
// focus follow-up: the first stand-in rendered a bare textarea AT ONCE, which
// is exactly what hid the bug): the composer carries `data-composer-input`,
// an unrelated queued-prompt textarea comes first in the DOM, and the
// composer can be held back until "the runtime boots" (leafHarness.late).
const leafHarness = vi.hoisted(() => ({ late: false, reveal: () => {} }))
vi.mock('@renderer/workspace/tile-tree/TileTree', async () => {
  const { useEffect, useState } = await import('react')
  function Leaf({ sessionId }: { sessionId: string }) {
    const [ready, setReady] = useState(!leafHarness.late)
    useEffect(() => { leafHarness.reveal = () => setReady(true) }, [])
    return (
      <>
        <textarea aria-label={`queued ${sessionId}`} />
        {ready ? <textarea aria-label={`leaf ${sessionId}`} data-composer-input={sessionId} /> : null}
      </>
    )
  }
  return { renderWorkspaceLeaf: (sessionId: string) => <Leaf sessionId={sessionId} /> }
})

vi.mock('@renderer/features/hermes-chat/useHermesConnections', () => ({ useHermesConnections: () => null }))
// The surface test below mounts SidekickPanelSurface; its window-wide duties
// (index sync over IPC, persistence to main) are not what it is about.
vi.mock('@renderer/features/sidekick/state/useSidekickIndexSync', () => ({ useSidekickIndexSync: () => {} }))
vi.mock('@renderer/features/sidekick/actions/useSidekickPersistence', () => ({ useSidekickPersistence: () => {} }))
// The real confirm needs the ConfirmHost; what these tests own is WHO asks.
const confirmRemove = vi.hoisted(() => vi.fn(async (_actions: unknown, _sidekickId: string, _toast: unknown) => undefined))
vi.mock('@renderer/features/sidekick/ui/confirmRemoveSidekick', () => ({ confirmRemoveSidekick: confirmRemove }))
const surfaceDeps = vi.hoisted(() => ({ workspace: null as unknown, actions: null as unknown }))
vi.mock('@renderer/workspace/WorkspaceContext', () => ({ useWorkspaceContext: () => surfaceDeps.workspace }))
vi.mock('@renderer/features/sidekick/actions/useSidekickActions', async importOriginal => ({
  ...(await importOriginal<object>()),
  useSidekickActions: () => surfaceDeps.actions,
}))

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

  it('waits for the composer that mounts AFTER the row is held, and never lands in another textarea (focus follow-up)', async () => {
    // The real bug: the composer mounts once the runtime boots, after the
    // one-frame focus attempt had already given up, so the caret stayed in
    // the lane composer and typing went to the lane.
    useSidekickIndexStore.getState().accept(view([summary('this-window')]))
    leafHarness.late = true
    const lane = document.createElement('textarea')
    document.body.append(lane)
    lane.focus()
    act(() => { useAppStore.getState().setKeyboardRegion('sidekick') })
    try {
      render(<SidekickPanel workspace={workspaceWith({ sk: { kind: 'claude', cwd: HOME, sidekickId: ID } })} actions={actionsWith(vi.fn())} />)
      // Nothing to focus yet: the caret is left where it was, not put in the
      // queued-prompt editor.
      expect(document.activeElement).toBe(lane)
      act(() => { leafHarness.reveal() })
      await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('leaf sk')))
    } finally {
      leafHarness.late = false
    }
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

describe('Sidekick column is a native lane (#1493 follow-up)', () => {
  const second = { ...summary(null), id: '00000000-0000-4000-8000-000000000002', sessionId: 'sk2' }

  it('resizes from a boundary handle that sits in flow, not clipped inside the panel', () => {
    // The first cut put the handle at left-0 -translate-x-1/2 inside an
    // overflow-hidden aside: half of it was clipped and the rest sat on the
    // border, so the panel looked (and mostly was) not resizable.
    useSidekickIndexStore.getState().accept(view([summary('this-window')]))
    const workspace = workspaceWith({ sk: { kind: 'claude', cwd: HOME, sidekickId: ID } })
    render(<SidekickPanel workspace={workspace} actions={actionsWith(vi.fn())} />)
    const handle = screen.getByRole('separator', { name: 'Resize Sidekick' })
    expect(handle.parentElement).toBe(screen.getByRole('region', { name: 'Sidekick' }))
    fireEvent.mouseDown(handle)
    fireEvent.mouseMove(window, { clientX: window.innerWidth - 500 })
    fireEvent.mouseUp(window)
    // The stored width is the agent area: the column's 56px of chrome
    // (10px boundary + 46px strip) is not part of it, so saved widths from
    // before the lane-shaped column keep their agent size.
    expect(workspace.setSidekickPanel).toHaveBeenCalledWith({ width: 444 })
  })

  it('switches sidekicks from the chip strip, with no panel header of its own', () => {
    useSidekickIndexStore.getState().accept(view([summary('this-window'), second]))
    const workspace = workspaceWith({ sk: { kind: 'claude', cwd: HOME, sidekickId: ID } })
    render(<SidekickPanel workspace={workspace} actions={actionsWith(vi.fn())} />)
    expect(screen.queryByRole('button', { name: 'Hide Sidekick' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^S2/ }))
    expect(workspace.setSidekickPanel).toHaveBeenCalledWith({ sidekickId: second.id })
    expect(useAppStore.getState().keyboardRegion).toBe('sidekick')
  })

  it('stays mounted but hidden under Settings, and gives the keyboard back to the workspace', () => {
    useSidekickIndexStore.getState().accept(view([summary('this-window')]))
    surfaceDeps.workspace = workspaceWith({ sk: { kind: 'claude', cwd: HOME, sidekickId: ID } })
    surfaceDeps.actions = actionsWith(vi.fn())
    act(() => { useAppStore.getState().setKeyboardRegion('sidekick') })
    render(<SidekickPanelSurface />)
    const leaf = screen.getByLabelText('leaf sk')
    expect(leaf.closest('[data-testid="retained-workspace-surface"]')?.getAttribute('style')).toContain('contents')
    act(() => { useAppStore.getState().openSettingsPage() })
    // Same element: retained, not remounted (an xterm would be disposed).
    expect(screen.getByLabelText('leaf sk', { selector: 'textarea' })).toBe(leaf)
    expect(leaf.closest('[data-testid="retained-workspace-surface"]')?.getAttribute('style')).toContain('none')
    expect(useAppStore.getState().keyboardRegion).toBe('workspace')
  })

  it("routes a chip's right-click menu to Reload, Remove and Hide", async () => {
    useSidekickIndexStore.getState().accept(view([summary('this-window')]))
    const workspace = workspaceWith({ sk: { kind: 'claude', cwd: HOME, sidekickId: ID } })
    const pick = { next: 'reload' as string | null }
    const showPopupMenu = vi.fn(async () => pick.next)
    Object.defineProperty(window, 'api', { configurable: true, value: { showPopupMenu } })
    render(<SidekickPanel workspace={workspace} actions={actionsWith(vi.fn())} />)
    const chip = screen.getByRole('button', { name: /^S1/ })
    fireEvent.contextMenu(chip)
    await waitFor(() => expect(workspace.reloadSessionAgent).toHaveBeenCalledWith('sk'))
    // The chip's menu only: the strip's own menu must not open as well.
    expect(showPopupMenu).toHaveBeenCalledTimes(1)
    pick.next = 'hide'
    fireEvent.contextMenu(chip)
    await waitFor(() => expect(workspace.setSidekickPanel).toHaveBeenCalledWith({ open: false }))
  })

  it('keeps Hide reachable by mouse when there is no sidekick (no chip to right-click)', async () => {
    useSidekickIndexStore.getState().accept(view([]))
    const workspace = workspaceWith({})
    const showPopupMenu = vi.fn(async () => 'hide')
    Object.defineProperty(window, 'api', { configurable: true, value: { showPopupMenu } })
    render(<SidekickPanel workspace={workspace} actions={actionsWith(vi.fn())} />)
    // The strip's + button (the empty body has its own New Sidekick… button).
    fireEvent.contextMenu(screen.getByTitle('New Sidekick…'))
    await waitFor(() => expect(workspace.setSidekickPanel).toHaveBeenCalledWith({ open: false }))
  })

  it('dragging the boundary never moves the keyboard between regions', () => {
    useSidekickIndexStore.getState().accept(view([summary('this-window')]))
    render(<SidekickPanel workspace={workspaceWith({ sk: { kind: 'claude', cwd: HOME, sidekickId: ID } })} actions={actionsWith(vi.fn())} />)
    const Region = () => { useKeyboardRegionFollowsPointer(); return null }
    render(<Region />)
    act(() => { useAppStore.getState().setKeyboardRegion('workspace') })
    fireEvent.pointerDown(screen.getByRole('separator', { name: 'Resize Sidekick' }))
    expect(useAppStore.getState().keyboardRegion).toBe('workspace')
  })
})

describe('Sidekick Spotlight (#1493 follow-up)', () => {
  it('fills the window with the SAME leaf (no remount) and drops the resize boundary', () => {
    useSidekickIndexStore.getState().accept(view([summary('this-window')]))
    const workspace = workspaceWith({ sk: { kind: 'claude', cwd: HOME, sidekickId: ID } })
    render(<SidekickPanel workspace={workspace} actions={actionsWith(vi.fn())} />)
    const leaf = screen.getByLabelText('leaf sk')
    act(() => { useAppStore.getState().setSidekickSpotlight(true) })
    const region = screen.getByRole('region', { name: 'Sidekick' })
    expect(region.className).toContain('flex-1')
    expect(region.getAttribute('style')).toBeNull()
    expect(screen.queryByRole('separator', { name: 'Resize Sidekick' })).toBeNull()
    // An xterm in the sidekick would be disposed and replayed on a remount.
    expect(screen.getByLabelText('leaf sk')).toBe(leaf)
    act(() => { useAppStore.getState().setSidekickSpotlight(false) })
    expect(screen.getByRole('separator', { name: 'Resize Sidekick' })).toBeTruthy()
    expect(screen.getByLabelText('leaf sk')).toBe(leaf)
  })

  it('the Spotlight command spotlights the sidekick from its region, exits it from anywhere, and leaves lane Spotlight alone otherwise', () => {
    const command = spotlightCommands.find(entry => entry.id === 'toggle-spotlight')!
    const workspace = { ...workspaceWith({}), toggleSpotlight: vi.fn() } as unknown as Workspace
    act(() => { useAppStore.getState().setKeyboardRegion('sidekick') })
    command.run({ workspace } as never)
    expect(useAppStore.getState().sidekickSpotlight).toBe(true)
    act(() => { useAppStore.getState().setKeyboardRegion('workspace') })
    command.run({ workspace } as never)
    expect(useAppStore.getState().sidekickSpotlight).toBe(false)
    command.run({ workspace } as never)
    expect(workspace.toggleSpotlight).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().sidekickSpotlight).toBe(false)
  })

  it('is only on screen while the panel is open and Settings is not covering it', () => {
    const open = { sidekickPanel: { open: true, width: 420, sidekickId: ID } }
    expect(sidekickSpotlightActive({ sidekickSpotlight: true, settingsPageOpen: false }, open)).toBe(true)
    expect(sidekickSpotlightActive({ sidekickSpotlight: true, settingsPageOpen: true }, open)).toBe(false)
    expect(sidekickSpotlightActive({ sidekickSpotlight: true, settingsPageOpen: false }, { sidekickPanel: { ...open.sidekickPanel, open: false } })).toBe(false)
  })

  it('hiding the Sidekick clears its Spotlight, so the next ⌘J does not reopen it full-window', () => {
    useSidekickIndexStore.getState().accept(view([summary('this-window')]))
    const ws = workspaceWith({ sk: { kind: 'claude', cwd: HOME, sidekickId: ID } })
    surfaceDeps.workspace = { ...ws, state: { ...ws.state, sidekickPanel: { open: false, width: 420, sidekickId: ID } } }
    surfaceDeps.actions = actionsWith(vi.fn())
    act(() => { useAppStore.getState().setSidekickSpotlight(true) })
    render(<SidekickPanelSurface />)
    expect(useAppStore.getState().sidekickSpotlight).toBe(false)
  })
  it('keeps the keyboard with a spotlit Sidekick: clicks on app chrome do not hand it to hidden lanes, and leaving Settings gives it back', () => {
    useSidekickIndexStore.getState().accept(view([summary('this-window')]))
    surfaceDeps.workspace = workspaceWith({ sk: { kind: 'claude', cwd: HOME, sidekickId: ID } })
    surfaceDeps.actions = actionsWith(vi.fn())
    act(() => {
      useAppStore.getState().setSidekickSpotlight(true)
      useAppStore.getState().setKeyboardRegion('sidekick')
    })
    render(<SidekickPanelSurface />)
    const chrome = document.createElement('button')
    document.body.append(chrome)
    fireEvent.pointerDown(chrome)
    expect(useAppStore.getState().keyboardRegion).toBe('sidekick')
    act(() => { useAppStore.getState().openSettingsPage() })
    expect(useAppStore.getState().keyboardRegion).toBe('workspace')
    act(() => { useAppStore.getState().closeSettingsPage() })
    expect(useAppStore.getState().keyboardRegion).toBe('sidekick')
  })
  it('runs a ⌘W remove request through the confirm, once, and clears it', () => {
    // close-pane on a sidekick target posts the request (paneCommands); the
    // surface owns the main-side removal.
    useSidekickIndexStore.getState().accept(view([summary('this-window')]))
    surfaceDeps.workspace = workspaceWith({ sk: { kind: 'claude', cwd: HOME, sidekickId: ID } })
    surfaceDeps.actions = actionsWith(vi.fn())
    confirmRemove.mockClear()
    render(<SidekickPanelSurface />)
    act(() => { useAppStore.getState().requestSidekickRemove(ID) })
    expect(confirmRemove).toHaveBeenCalledTimes(1)
    expect(confirmRemove.mock.calls[0]?.[1]).toBe(ID)
    expect(useAppStore.getState().sidekickRemoveRequest).toBeNull()
  })
})
