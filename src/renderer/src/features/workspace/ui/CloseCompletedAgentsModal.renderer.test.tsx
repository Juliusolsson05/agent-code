import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { emptyRuntime } from '@renderer/session-runtime/state'
import type { WorkspaceState } from '@renderer/workspace/types'
import type { TldrRecord, TldrUpdate } from '@shared/types/tldr'
import { CloseCompletedAgentsModal } from './CloseCompletedAgentsModal'

// The modal's own contract (#1182): what it OFFERS and what it HANDS to the
// flow. The flow's safety is pinned against the real executor in
// completedGoalAgents.renderer.test.tsx; this file pins the choices the user
// makes here — which rows, and whether lanes go — reaching it intact, and the
// list following goal changes while it is open.

const originalApi = window.api
afterEach(() => { cleanup(); window.api = originalApi })

const goal = (text: string, revision: number, note?: string): TldrRecord => ({
  text, revision, updatedAt: '2026-09-24T10:00:00.000Z',
  ...(note ? { completedAt: new Date().toISOString(), completionNote: note } : {}),
})

function setup(records: Record<string, TldrRecord>, options: { read?: (identities: string[]) => Promise<Record<string, TldrRecord>> } = {}) {
  const listeners = new Set<(update: TldrUpdate) => void>()
  window.api = {
    ...originalApi,
    readGoals: vi.fn(options.read ?? (async (identities: string[]) => Object.fromEntries(identities.filter(id => records[id]).map(id => [id, records[id]!])))),
    onGoalChanged: vi.fn((listener: (update: TldrUpdate) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }),
  }
  const state = {
    tabs: [{ id: 'tab', title: 'repo' }],
    activeTabId: 'tab',
    stage: { lanes: [{ selectedSessionId: 'a' }, { selectedSessionId: 'b' }, { selectedSessionId: 'c' }], rows: [{ length: 3 }], focusedLane: 0 },
    sessions: {
      a: { cwd: '/repo/a', kind: 'claude', title: 'Feature A', tldrIdentity: 'id-a', builtInMcpDomains: ['goal'], projectId: 'tab', joinedAt: 0 },
      b: { cwd: '/repo/b', kind: 'codex', title: 'Feature B', tldrIdentity: 'id-b', builtInMcpDomains: ['goal'], projectId: 'tab', joinedAt: 1 },
      c: { cwd: '/repo/c', kind: 'claude', title: 'Feature C', tldrIdentity: 'id-c', builtInMcpDomains: ['goal'], projectId: 'tab', joinedAt: 2 },
    },
    pinnedSessionIds: [],
  } as unknown as WorkspaceState
  const idle = { ...emptyRuntime(), processStatus: 'started' as const, inputReady: true }
  const runtimes = { a: idle, b: { ...idle, sessionStatus: 'running' as const, streamPhase: 'tool-use' as const }, c: idle }
  const closeCompletedGoalAgents = vi.fn(async (_selection: string[], _options: { removeLanes: boolean; readGoals: () => Record<string, TldrRecord> }) => null)
  const onClose = vi.fn()
  const view = render(<CloseCompletedAgentsModal open onClose={onClose} workspace={{ state, runtimes, closeCompletedGoalAgents } as never} />)
  const rerenderWith = (next: Record<string, unknown>) => view.rerender(<CloseCompletedAgentsModal open onClose={onClose} workspace={{ state, runtimes: { ...runtimes, ...next }, closeCompletedGoalAgents } as never} />)
  const emit = (identity: string, record: TldrRecord) => act(() => { for (const listener of listeners) listener({ identity, record }) })
  return { closeCompletedGoalAgents, onClose, emit, rerenderWith, idle }
}

describe('Close Completed Agents modal', () => {
  it('uses the shared footer: Cancel ⎋, and no Enter chip on the destructive close (plan S14)', async () => {
    setup({ 'id-a': goal('Ship A.', 2, 'PR #1 merged.') })
    await screen.findByText('✓ PR #1 merged.')
    expect(screen.getByRole('button', { name: 'Cancel' }).querySelector('[data-slot="kbd"]')?.textContent).toBe('⎋')
    expect(screen.getByRole('button', { name: 'Close 1 Agent' }).querySelector('[data-slot="kbd"]')).toBeNull()
    expect(screen.getByRole('button', { name: 'Close 1 Agent' }).closest('[data-slot="dialog-footer"]')).not.toBeNull()
  })

  it('ticks idle completed agents, keeps a running one unselectable, and hands over the user’s choices', async () => {
    const { closeCompletedGoalAgents, onClose } = setup({
      'id-a': goal('Ship A.', 2, 'PR #1 merged.'),
      'id-b': goal('Ship B.', 2, 'PR #2 merged.'),
      'id-c': goal('Ship C.', 1),
    })
    expect(await screen.findByText('✓ PR #1 merged.')).toBeTruthy()
    // An incomplete goal is not offered at all.
    expect(screen.queryByText('Ship C.')).toBeNull()
    const a = screen.getByRole('checkbox', { name: 'Close Feature A' }) as HTMLInputElement
    const b = screen.getByRole('checkbox', { name: 'Close Feature B' }) as HTMLInputElement
    expect(a.checked).toBe(true)
    expect(b.checked).toBe(false)
    expect(b.disabled).toBe(true)
    expect(screen.getByText('1 agent stays open')).toBeTruthy()

    fireEvent.click(screen.getByRole('checkbox', { name: 'Also remove their lanes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close 1 Agent' }))

    await waitFor(() => expect(closeCompletedGoalAgents).toHaveBeenCalledOnce())
    expect(closeCompletedGoalAgents).toHaveBeenCalledWith(['a'], { removeLanes: false, readGoals: expect.any(Function) })
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('follows goal changes while open: a new completion arrives ticked, a new goal removes its row', async () => {
    const { closeCompletedGoalAgents, emit } = setup({
      'id-a': goal('Ship A.', 2, 'PR #1 merged.'),
      'id-c': goal('Ship C.', 1),
    })
    await screen.findByText('✓ PR #1 merged.')

    emit('id-c', goal('Ship C.', 2, 'PR #3 merged.'))
    const c = await screen.findByRole('checkbox', { name: 'Close Feature C' }) as HTMLInputElement
    expect(c.checked).toBe(true)

    // Agent A was given new work: its goal_set cleared the completion.
    emit('id-a', goal('Start feature E.', 3))
    expect(screen.queryByRole('checkbox', { name: 'Close Feature A' })).toBeNull()

    // An older record arriving late must not resurrect the completion.
    emit('id-a', goal('Ship A.', 2, 'PR #1 merged.'))
    expect(screen.queryByRole('checkbox', { name: 'Close Feature A' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Close 1 Agent' }))
    await waitFor(() => expect(closeCompletedGoalAgents).toHaveBeenCalledWith(['c'], { removeLanes: true, readGoals: expect.any(Function) }))
  })

  it('explains an empty list instead of offering a close', async () => {
    setup({ 'id-a': goal('Ship A.', 1) })
    expect(await screen.findByText(/No agent has completed its goal/)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Close 0 Agents' }) as HTMLButtonElement).disabled).toBe(true)
  })

  // #1184 review: the headline guarantee is that the close sees a goal set
  // AFTER the click, which is why the modal hands over a reader, not a map.
  it('hands the flow a reader that sees goal changes made after the click', async () => {
    const { closeCompletedGoalAgents, emit } = setup({ 'id-a': goal('Ship A.', 2, 'PR #1 merged.') })
    await screen.findByText('✓ PR #1 merged.')
    fireEvent.click(screen.getByRole('button', { name: 'Close 1 Agent' }))
    await waitFor(() => expect(closeCompletedGoalAgents).toHaveBeenCalledOnce())
    const readGoals = closeCompletedGoalAgents.mock.calls[0]![1].readGoals
    emit('id-a', goal('Start feature E.', 3))
    expect(readGoals()['id-a']).toMatchObject({ text: 'Start feature E.', revision: 3 })
    expect(readGoals()['id-a']).not.toHaveProperty('completedAt')
  })

  it('offers no close until the fresh read lands, and none at all after a failed one', async () => {
    const pending = setup({}, { read: () => new Promise(() => {}) })
    // A completion heard on the subscription while the read is in flight is
    // shown, but the list is not trusted for a close yet.
    pending.emit('id-a', goal('Ship A.', 2, 'PR #1 merged.'))
    await screen.findByText('✓ PR #1 merged.')
    expect((screen.getByRole('button', { name: 'Close 1 Agent' }) as HTMLButtonElement).disabled).toBe(true)
    cleanup()

    const failed = setup({}, { read: async () => { throw new Error('Goal storage is invalid.') } })
    failed.emit('id-a', goal('Ship A.', 2, 'PR #1 merged.'))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Close 1 Agent' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Close 1 Agent' }))
    expect(failed.closeCompletedGoalAgents).not.toHaveBeenCalled()
  })

  it('keeps a row the user saw running unticked after it stops, until they tick it', async () => {
    const { rerenderWith, idle, closeCompletedGoalAgents } = setup({
      'id-a': goal('Ship A.', 2, 'PR #1 merged.'),
      'id-b': goal('Ship B.', 2, 'PR #2 merged.'),
    })
    await screen.findByText('✓ PR #2 merged.')
    rerenderWith({ b: idle })
    const b = screen.getByRole('checkbox', { name: 'Close Feature B' }) as HTMLInputElement
    expect(b.disabled).toBe(false)
    expect(b.checked).toBe(false)
    fireEvent.click(b)
    fireEvent.click(screen.getByRole('button', { name: 'Close 2 Agents' }))
    await waitFor(() => expect(closeCompletedGoalAgents).toHaveBeenCalledOnce())
    expect([...closeCompletedGoalAgents.mock.calls[0]![0]].sort()).toEqual(['a', 'b'])
  })
})

