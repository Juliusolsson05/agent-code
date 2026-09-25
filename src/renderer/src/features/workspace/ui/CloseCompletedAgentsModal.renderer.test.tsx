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

function setup(records: Record<string, TldrRecord>) {
  const listeners = new Set<(update: TldrUpdate) => void>()
  window.api = {
    ...originalApi,
    readGoals: vi.fn(async (identities: string[]) => Object.fromEntries(identities.filter(id => records[id]).map(id => [id, records[id]!]))),
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
  const closeCompletedGoalAgents = vi.fn(async () => null)
  const onClose = vi.fn()
  render(<CloseCompletedAgentsModal open onClose={onClose} workspace={{ state, runtimes, closeCompletedGoalAgents } as never} />)
  const emit = (identity: string, record: TldrRecord) => act(() => { for (const listener of listeners) listener({ identity, record }) })
  return { closeCompletedGoalAgents, onClose, emit }
}

describe('Close Completed Agents modal', () => {
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
    expect(screen.getByText('1 running agent stays open')).toBeTruthy()

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
})
