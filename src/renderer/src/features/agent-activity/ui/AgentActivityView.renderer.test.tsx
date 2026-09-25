import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import type { ProviderConditionSnapshot } from '@shared/types/providerConditions'
import type { TldrRecord } from '@shared/types/tldr'

import { AgentActivityView } from './AgentActivityView'

// What the user SEES and what their keys DO in the full-screen Agent Activity
// (#1170). The sectioning rules are pinned against the recorded corpus in
// activityRow.test.ts; this file pins the surface on top of them: section
// order, the Goal name arriving from one batched read, and the keyboard
// grammar — in particular that typing a filter can never select or close.

const originalApi = Object.getOwnPropertyDescriptor(window, 'api')
const readTldrs = vi.fn(async (_ids: string[]): Promise<Record<string, TldrRecord>> => ({
  'id-idle-old': { text: 'Waiting for review comments', updatedAt: '', revision: 1 },
}))
const readGoals = vi.fn(async (_ids: string[]): Promise<Record<string, TldrRecord>> => ({
  'id-idle-old': { text: 'Ship the login fix', updatedAt: '', revision: 1 },
}))
const readGoalLoops = vi.fn(async () => ({}))

beforeEach(() => {
  readTldrs.mockClear()
  readGoals.mockClear()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      readTldrs,
      readGoals,
      onTldrChanged: () => () => {},
      onGoalChanged: () => () => {},
      readGoalLoops,
      onGoalLoopChanged: () => () => {},
    },
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  if (originalApi) Object.defineProperty(window, 'api', originalApi)
  else Reflect.deleteProperty(window, 'api')
})

const idle = (lastJsonlEntryAt: number): SessionRuntime => ({ ...emptyRuntime(), sessionStatus: 'idle', lastJsonlEntryAt })

function fleet(): Workspace {
  const asking: SessionRuntime = {
    ...idle(Date.now() - 60_000),
    conditions: {
      provider: 'codex',
      ts: 1,
      conditions: { 'codex.approval': { kind: 'codex.approval', state: {}, actions: [] } },
    } as unknown as ProviderConditionSnapshot,
  }
  return {
    state: {
      activeTabId: 'tab',
      tabs: [{ id: 'tab', title: 'agent-code' }],
      sessions: {
        asking: { cwd: '/w/agent-code', kind: 'codex', projectId: 'tab', joinedAt: 0 },
        busy: { cwd: '/w/agent-code', kind: 'claude', title: 'Refactor the store', projectId: 'tab', joinedAt: 1 },
        'idle-old': { cwd: '/w/agent-code', kind: 'claude', tldrIdentity: 'id-idle-old', projectId: 'tab', joinedAt: 2 },
        'idle-new': { cwd: '/w/other-repo', kind: 'claude', projectId: 'tab', joinedAt: 3 },
      },
      pinnedSessionIds: [],
      stage: { lanes: [{ selectedSessionId: 'busy' }], rows: [{ length: 1 }], focusedLane: 0 },
    },
    runtimes: {
      asking,
      busy: { ...idle(Date.now()), sessionStatus: 'running', streamPhase: 'thinking' },
      'idle-old': idle(Date.now() - 3 * 86_400_000),
      'idle-new': idle(Date.now() - 3_600_000),
    },
    focusAgentBySessionId: vi.fn(async () => true),
    closeAgentActivitySelection: vi.fn(async () => null),
  } as unknown as Workspace
}

async function openView(workspace = fleet()) {
  const onClose = vi.fn()
  const mounted = render(<AgentActivityView open workspace={workspace} onClose={onClose} />)
  // Let the batched note reads resolve.
  await act(async () => { await Promise.resolve() })
  const list = screen.getByRole('listbox', { name: 'Agents' })
  list.focus()
  return { workspace, onClose, mounted, list }
}

const rowNames = () => screen.getAllByRole('option').map(option => option.getAttribute('data-session-id'))

describe('Agent Activity, full screen', () => {
  it('shows who needs you first, then who is working, then the longest-idle agents first', async () => {
    await openView()
    expect(rowNames()).toEqual(['asking', 'busy', 'idle-old', 'idle-new'])
    expect(within(screen.getByRole('group', { name: 'Needs you' })).getByText('Wants permission')).toBeInTheDocument()
    expect(screen.getByText('1 need you · 1 working · 2 idle')).toBeInTheDocument()
  })

  it('reads every note in one call per kind, and names an untitled agent by its Goal', async () => {
    await openView()
    // Four rows, one of them with a tldrIdentity: one TLDR read, one Goal
    // read — never one per row. Agents with no identity are never asked about.
    expect(readTldrs).toHaveBeenCalledOnce()
    expect(readTldrs).toHaveBeenCalledWith(['id-idle-old'])
    expect(readGoals).toHaveBeenCalledOnce()
    const row = screen.getByRole('option', { name: /Ship the login fix/ })
    expect(within(row).getByText('goal')).toBeInTheDocument()
    expect(within(row).getByText('Waiting for review comments')).toBeInTheDocument()
  })

  it('reads and subscribes to nothing while closed, and lets go of its subscriptions on close', async () => {
    const subscriptions = { tldr: 0, goal: 0, loop: 0 }
    const unsubscribed = { tldr: 0, goal: 0, loop: 0 }
    const track = (key: keyof typeof subscriptions) => () => {
      subscriptions[key] += 1
      return () => { unsubscribed[key] += 1 }
    }
    Object.assign(window.api, {
      onTldrChanged: track('tldr'), onGoalChanged: track('goal'), onGoalLoopChanged: track('loop'),
    })
    readGoalLoops.mockClear()
    const workspace = fleet()
    const mounted = render(<AgentActivityView open={false} workspace={workspace} onClose={vi.fn()} />)
    mounted.rerender(<AgentActivityView open={false} workspace={{ ...workspace, runtimes: { ...workspace.runtimes } }} onClose={vi.fn()} />)
    expect(readTldrs).not.toHaveBeenCalled()
    expect(readGoals).not.toHaveBeenCalled()
    expect(readGoalLoops).not.toHaveBeenCalled()
    expect(subscriptions).toEqual({ tldr: 0, goal: 0, loop: 0 })

    mounted.rerender(<AgentActivityView open workspace={workspace} onClose={vi.fn()} />)
    await act(async () => { await Promise.resolve() })
    expect(subscriptions).toEqual({ tldr: 1, goal: 1, loop: 1 })

    mounted.rerender(<AgentActivityView open={false} workspace={workspace} onClose={vi.fn()} />)
    expect(unsubscribed).toEqual({ tldr: 1, goal: 1, loop: 1 })
  })

  it('leaves Enter on a focused footer button to the button', async () => {
    const { workspace, list } = await openView()
    fireEvent.keyDown(list, { key: ' ' })
    const button = screen.getByRole('button', { name: 'Close 1 selected' })
    fireEvent.keyDown(button, { key: 'Enter' })
    // Not intercepted as "open the highlighted agent".
    expect(workspace.focusAgentBySessionId).not.toHaveBeenCalled()
  })

  it('selects with Space and closes the selection with ⌫, through the confirming bulk flow', async () => {
    const { workspace, list } = await openView()
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    fireEvent.keyDown(list, { key: ' ' })
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    fireEvent.keyDown(list, { key: ' ' })
    fireEvent.keyDown(list, { key: 'Backspace' })
    expect(workspace.closeAgentActivitySelection).toHaveBeenCalledWith([
      { sessionId: 'idle-old', name: 'Ship the login fix' },
      { sessionId: 'idle-new', name: 'other-repo' },
    ])
  })

  it('turns a typed letter into a filter, and typing there never selects or closes', async () => {
    const { workspace, list } = await openView()
    fireEvent.keyDown(list, { key: 'o' })
    const filter = screen.getByRole('textbox', { name: 'Filter agents' })
    expect(filter).toHaveFocus()
    expect(filter).toHaveValue('o')
    fireEvent.change(filter, { target: { value: 'other repo' } })
    expect(rowNames()).toEqual(['idle-new'])
    // Space and ⌫ inside the field are text editing, not list commands.
    fireEvent.keyDown(filter, { key: ' ' })
    fireEvent.keyDown(filter, { key: 'Backspace' })
    expect(workspace.closeAgentActivitySelection).not.toHaveBeenCalled()
    expect(screen.getByRole('option').getAttribute('aria-selected')).toBe('false')
  })

  it('keeps a selection while the user filters to find more rows to add to it', async () => {
    const { workspace, list } = await openView()
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    fireEvent.keyDown(list, { key: ' ' }) // idle-old
    fireEvent.keyDown(list, { key: 'o' })
    const filter = screen.getByRole('textbox', { name: 'Filter agents' })
    fireEvent.change(filter, { target: { value: 'other' } })
    // Tab, not list.focus(): the keyboard path back to the list with the
    // query kept is the thing under test (review of #1105).
    fireEvent.keyDown(filter, { key: 'Tab' })
    expect(list).toHaveFocus()
    fireEvent.keyDown(list, { key: ' ' }) // idle-new, the only row shown now
    fireEvent.keyDown(list, { key: 'Backspace' })
    expect(workspace.closeAgentActivitySelection).toHaveBeenCalledWith([
      { sessionId: 'idle-old', name: 'Ship the login fix' },
      { sessionId: 'idle-new', name: 'other-repo' },
    ])
  })

  it('Esc in the filter clears it without dismissing the view', async () => {
    const { onClose, list } = await openView()
    fireEvent.keyDown(list, { key: 'o' })
    const filter = screen.getByRole('textbox', { name: 'Filter agents' })
    fireEvent.keyDown(filter, { key: 'Escape' })
    expect(filter).toHaveValue('')
    expect(onClose).not.toHaveBeenCalled()
    expect(rowNames()).toHaveLength(4)
  })

  it('Enter opens the highlighted agent and dismisses the view', async () => {
    const { workspace, onClose, list } = await openView()
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    fireEvent.keyDown(list, { key: 'Enter' })
    expect(workspace.focusAgentBySessionId).toHaveBeenCalledWith('busy')
    expect(onClose).toHaveBeenCalled()
  })
})
