import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useAppStore } from '@renderer/app-state/store'
import type { SidekickActions } from '@renderer/features/sidekick/actions/useSidekickActions'
import { useSidekickIndexStore } from '@renderer/features/sidekick/state/sidekickIndexStore'
import type { Workspace } from '@renderer/workspace/workspaceStore'

import { AGENT_PROVIDER_CHOICES } from '@renderer/workspace/providerChoices'
import type { HermesConnectionInfo } from '@shared/hermes/types'

import { SidekickPanelBody } from './SidekickPanel'
import { newSidekickChoices, SidekickPicker } from './SidekickPicker'

vi.mock('@renderer/features/hermes-chat/useHermesConnections', () => ({ useHermesConnections: () => null }))

// Hermes is first-class in the Sidekick Picker (#1493, plan Decision 5):
// first when a connection can actually serve it, still listed — disabled,
// with the fix — when none is signed in, never silently hidden.

function connection(state: HermesConnectionInfo['state']): HermesConnectionInfo {
  return { id: 'conn', name: 'VPS', baseUrl: 'https://hermes.example', createdAt: 0, state, identity: null, backend: null, lastError: null }
}

const order = (rows: ReturnType<typeof newSidekickChoices>) => rows.map(row => `${row.choice.kind}${row.choice.providerRuntime ? `:${row.choice.providerRuntime}` : ''}${row.disabledReason ? ' (disabled)' : ''}`)

describe('New Sidekick choices', () => {
  it('puts Hermes first when a connection is ready', () => {
    const rows = newSidekickChoices(AGENT_PROVIDER_CHOICES, [connection('ready')])
    expect(order(rows)[0]).toBe('hermes')
    expect(rows.every(row => row.disabledReason === null)).toBe(true)
  })

  it('keeps Hermes enabled but last when the signed-in server is unreachable', () => {
    const rows = newSidekickChoices(AGENT_PROVIDER_CHOICES, [connection('unreachable')])
    expect(order(rows).at(-1)).toBe('hermes')
    expect(rows.find(row => row.choice.kind === 'hermes')?.disabledReason).toBeNull()
  })

  it('lists Hermes disabled, with the fix, when nothing is signed in', () => {
    for (const hermes of [null, [], [connection('signed-out')]]) {
      const rows = newSidekickChoices(AGENT_PROVIDER_CHOICES, hermes)
      expect(order(rows).at(-1)).toBe('hermes (disabled)')
      expect(rows.find(row => row.choice.kind === 'hermes')?.disabledReason).toBe('Sign in under Settings → Hermes')
    }
  })
})

describe('Sidekick panel body', () => {
  it('offers Open here for a sidekick live in another window', () => {
    const onOpenHere = vi.fn()
    render(<SidekickPanelBody state="elsewhere" failure={null} onOpenHere={onOpenHere} onRetry={vi.fn()} onNew={vi.fn()} />)
    expect(screen.getByText('Live in another window.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open here' }))
    expect(onOpenHere).toHaveBeenCalledOnce()
  })

  it('offers New Sidekick when there is none, and Retry with the reason on failure', () => {
    const onNew = vi.fn()
    const { unmount } = render(<SidekickPanelBody state="empty" failure={null} onOpenHere={vi.fn()} onRetry={vi.fn()} onNew={onNew} />)
    fireEvent.click(screen.getByRole('button', { name: 'New Sidekick…' }))
    expect(onNew).toHaveBeenCalledOnce()
    unmount()
    render(<SidekickPanelBody state="failed" failure="This sidekick no longer exists." onOpenHere={vi.fn()} onRetry={vi.fn()} onNew={vi.fn()} />)
    expect(screen.getByRole('alert').textContent).toBe('This sidekick no longer exists.')
  })
})

describe('the mounted picker (#1493 review round 1)', () => {
  const original = useAppStore.getState()
  afterEach(() => {
    useAppStore.setState(original, true)
    useSidekickIndexStore.setState({ view: null })
  })
  const ID = '00000000-0000-4000-8000-000000000001'

  function mount(restoreStatus: 'pending' | 'restored') {
    useSidekickIndexStore.getState().accept({ revision: 1, homeDir: '/home', sidekicks: [
      { id: ID, sessionId: 'sk', kind: 'claude', providerRuntime: null, title: 'Errands', agentNameId: null, remoteConnectionId: null, createdAt: 1, lastActiveAt: 1, liveWindowId: 'other-window' },
    ] })
    const workspace = { state: { ...original.workspaceState, sessions: {} }, restoreStatus, setSidekickPanel: vi.fn() } as unknown as Workspace
    const actions = { openHere: vi.fn(async () => ({ ok: true, record: {} })), createSidekick: vi.fn(), showSidekick: vi.fn(), removeSidekick: vi.fn(), onReleased: vi.fn() } as unknown as SidekickActions
    render(<SidekickPicker workspace={workspace} actions={actions} />)
    act(() => { useAppStore.getState().openSidekickPicker('switch') })
    return { workspace, actions }
  }

  it('Enter on a sidekick live in another window opens it HERE (F8)', async () => {
    // Picking it is the explicit move; landing on "Open here" asked twice.
    const { workspace, actions } = mount('restored')
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Enter' })
    await waitFor(() => expect(actions.openHere).toHaveBeenCalledWith(ID))
    expect(workspace.setSidekickPanel).toHaveBeenCalledWith({ open: true, sidekickId: ID })
  })

  it('lists New Sidekick rows as disabled while the workspace restores', () => {
    mount('pending')
    const rows = screen.getAllByRole('option').filter(row => row.getAttribute('aria-disabled') === 'true')
    expect(rows.length).toBeGreaterThan(0)
    expect(screen.getAllByText('Restoring the workspace…').length).toBe(rows.length)
  })
})
