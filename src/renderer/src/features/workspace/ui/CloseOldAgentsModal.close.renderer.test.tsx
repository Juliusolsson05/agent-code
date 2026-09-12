import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { projectScopeLabel } from '@renderer/features/workspace/lib/projectScope'
import { emptyRuntime } from '@renderer/session-runtime/state'
import { makeRefs, mountPaneActions } from '@renderer/workspace/hook/actions/testing/paneActionsHarness'
import type { WorkspaceState } from '@renderer/workspace/types'
import type { Workspace } from '@renderer/workspace/hook'
import type { Entry } from '@shared/types/transcript'
import { CloseOldAgentsModal } from './CloseOldAgentsModal'

const { showToast } = vi.hoisted(() => ({ showToast: vi.fn() }))
vi.mock('@renderer/ui/GlobalToast', () => ({ useGlobalToast: () => ({ showToast }) }))

const now = Date.parse('2026-09-11T12:00:00Z')
const old = now - 8 * 60 * 60 * 1000
const killOwnedSession = vi.fn(async (_owner: { sessionId: string }) => true)
const originalApi = Object.getOwnPropertyDescriptor(window, 'api')

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(now)
  showToast.mockClear()
  killOwnedSession.mockReset().mockResolvedValue(true)
  Object.defineProperty(window, 'api', { configurable: true, value: { killOwnedSession } })
})
afterEach(() => {
  vi.restoreAllMocks()
  if (originalApi) Object.defineProperty(window, 'api', originalApi)
  else Reflect.deleteProperty(window, 'api')
})

function mountCleanup(options: { working?: boolean; linked?: boolean } = {}) {
  const state: WorkspaceState = {
    tabs: [{ id: 'tab', title: 'Project', root: { type: 'leaf', sessionId: 'root' }, focusedSessionId: 'root' }],
    activeTabId: 'tab', dispatchMode: { scope: 'project', focusedSessionId: 'root' },
    sessions: {
      root: { cwd: '/project', kind: 'claude' },
      worker: { cwd: '/project', kind: 'codex', ...(options.linked ? { linkedParentId: 'root' } : {}) },
    },
    detachedSessions: {
      worker: { sessionId: 'worker', surface: 'dispatch', projectTabId: 'tab', projectTabTitle: 'Project', projectTabIndex: 0, detachedAt: 1 },
    },
    gridRelatedSelections: {}, buried: [], pinnedSessionIds: [],
  }
  const refs = makeRefs(state)
  // Cleanup only reads timestamps; provider payloads do not determine age.
  const entries = [{ timestamp: new Date(old).toISOString() } as Entry]
  refs.latestRuntimesRef.current = {
    root: { ...emptyRuntime(), entries },
    worker: { ...emptyRuntime(), entries, processActive: options.working === true },
  }
  const harness = mountPaneActions(state, { refs, showToast })
  const onClose = vi.fn()
  const workspace: Pick<Workspace, 'state' | 'runtimes' | 'closeSession'> = {
    // Deliberately stale layout like a modal between React renders. The real
    // action refs still follow synchronous writes, and must be authoritative.
    state,
    get runtimes() { return refs.latestRuntimesRef.current },
    closeSession: harness.actions.closeSession,
  }
  const modal = render(<CloseOldAgentsModal open workspace={workspace} onClose={onClose} />)
  return { harness, refs, onClose, workspace, modal }
}

describe('Close Old Agents destructive scope (#886)', () => {
  it('previewing one old root never closes its excluded working Dispatch sibling', async () => {
    const { harness, onClose } = mountCleanup({ working: true })
    fireEvent.click(screen.getByRole('button', { name: 'Close 1 Agent' }))
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(killOwnedSession.mock.calls.map(([owner]) => owner.sessionId)).toEqual(['root'])
    expect(harness.getState().sessions.worker).toBeDefined()
    expect(harness.getState().tabs[0].root).toEqual({ type: 'leaf', sessionId: 'worker' })
    expect(showToast).toHaveBeenLastCalledWith('Closed 1 session.', 6000)
  })

  it.each(['starts working', 'finishes new work'])('skips the next agent if it %s during the first kill', async change => {
    let finishFirst!: (result: boolean) => void
    killOwnedSession.mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve }))
    const { harness, refs, onClose } = mountCleanup()
    fireEvent.click(screen.getByRole('button', { name: 'Close 2 Agents' }))
    await waitFor(() => expect(killOwnedSession).toHaveBeenCalledOnce())
    // No modal rerender: a destructive grant must consult live runtime evidence
    // even when React has not committed another preview.
    refs.latestRuntimesRef.current.worker = {
      ...refs.latestRuntimesRef.current.worker,
      ...(change === 'starts working' ? { processActive: true } : { phaseChangedAt: now }),
    }
    await act(async () => { finishFirst(true) })
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(killOwnedSession.mock.calls.map(([owner]) => owner.sessionId)).toEqual(['root'])
    expect(harness.getState().sessions.worker).toBeDefined()
    expect(showToast).toHaveBeenLastCalledWith('Closed 1, 1 skipped (changed).', 6000)
  })

  it('skips an eligible parent whose linked worker is excluded', async () => {
    const { harness, onClose } = mountCleanup({ working: true, linked: true })
    fireEvent.click(screen.getByRole('button', { name: 'Close 1 Agent' }))
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(killOwnedSession).not.toHaveBeenCalled()
    expect(Object.keys(harness.getState().sessions)).toEqual(['root', 'worker'])
    expect(showToast).toHaveBeenLastCalledWith('Closed 0, 1 skipped (changed).', 6000)
  })

  it('closes eligible linked children before their parent, counting each exactly once', async () => {
    const { harness, onClose } = mountCleanup({ linked: true })
    fireEvent.click(screen.getByRole('button', { name: 'Close 2 Agents' }))
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(killOwnedSession.mock.calls.map(([owner]) => owner.sessionId)).toEqual(['worker', 'root'])
    expect(harness.getState().sessions).toEqual({})
    expect(harness.getState().tabs).toEqual([])
    expect(harness.refs.undoStackRef.current.length).toBe(0)
  })

  it('continues after a backend failure and reports it without losing that session', async () => {
    killOwnedSession.mockRejectedValueOnce(new Error('backend refused'))
    const { harness, onClose } = mountCleanup()
    fireEvent.click(screen.getByRole('button', { name: 'Close 2 Agents' }))
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(harness.getState().sessions.root).toBeDefined()
    expect(harness.getState().sessions.worker).toBeUndefined()
    expect(showToast).toHaveBeenLastCalledWith('Closed 1, 1 failed.', 6000)
  })

  it('only includes old working agents after the explicit checkbox is selected', async () => {
    const { onClose } = mountCleanup({ working: true })
    expect(screen.getByRole('button', { name: 'Close 1 Agent' })).toBeEnabled()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include agents that are currently running' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close 2 Agents, Including 1 Running' }))
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(killOwnedSession.mock.calls.map(([owner]) => owner.sessionId)).toEqual(['root', 'worker'])
  })

  it('requires a selected project and refuses an invalid inactivity threshold', () => {
    mountCleanup()
    fireEvent.click(screen.getByRole('button', { name: 'Selected projects' }))
    expect(screen.getByRole('button', { name: 'Close 0 Agents' })).toBeDisabled()
    // WHY the name comes from projectScopeLabel instead of a literal: main's
    // #908 re-keyed this picker from working directory to project TAB, and the
    // row is now labelled the way the Dispatch index names projects
    // (`A · Project`) with the directories as a secondary line. The old
    // `/project \/project/` matcher encoded the retired cwd label, so it broke
    // on the merge even though the scope behavior under test (nothing closes
    // until a project is ticked, and ticking it admits exactly its agents) is
    // unchanged. Deriving the label from the shared helper keeps this test on
    // the picker's source of truth if the vocabulary moves again. `includes`
    // rather than equality because the checkbox's accessible name also carries
    // the directory line and the matching/total count.
    const projectLabel = projectScopeLabel(0, 'Project')
    fireEvent.click(screen.getByRole('checkbox', { name: name => name.includes(projectLabel) }))
    expect(screen.getByRole('button', { name: 'Close 2 Agents' })).toBeEnabled()
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '0' } })
    expect(screen.getByRole('button', { name: 'Close 0 Agents' })).toBeDisabled()
    expect(killOwnedSession).not.toHaveBeenCalled()
  })
})
