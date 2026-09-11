import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { emptyRuntime } from '@renderer/session-runtime/state'
import { buildVisibleDispatchRows } from '@renderer/workspace/dispatch/dispatchSelectors'
import {
  __resetCloseConfirmationForTests,
  currentCloseConfirmation,
  resolveCloseConfirmation,
} from '@renderer/workspace/closeConfirmationBroker'
import { makeRefs, mountPaneActions, mountUndoCloseAction } from './testing/paneActionsHarness'
import type { WorkspaceState } from '@renderer/workspace/types'

function project(): WorkspaceState {
  return {
    tabs: [{ id: 'project', title: 'Project', root: { type: 'leaf', sessionId: 'root' }, focusedSessionId: 'root' }],
    activeTabId: 'project',
    sessions: {
      root: { cwd: '/project', kind: 'claude', title: 'Old root' },
      worker: { cwd: '/project', kind: 'codex', title: 'Running worker' },
    },
    detachedSessions: {
      worker: { sessionId: 'worker', surface: 'dispatch', projectTabId: 'project', projectTabTitle: 'Project', projectTabIndex: 0, detachedAt: 1 },
    },
    dispatchMode: { scope: 'project', focusedSessionId: 'root' },
    gridRelatedSelections: {}, buried: [], pinnedSessionIds: [],
  }
}

const killOwnedSession = vi.fn(async (_owner: { sessionId: string }) => true)
const originalApi = Object.getOwnPropertyDescriptor(window, 'api')
beforeEach(() => {
  killOwnedSession.mockClear()
  Object.defineProperty(window, 'api', { configurable: true, value: { killOwnedSession } })
})
afterEach(() => {
  __resetCloseConfirmationForTests()
  if (originalApi) Object.defineProperty(window, 'api', originalApi)
  else Reflect.deleteProperty(window, 'api')
})

describe('root agent close scope (#153, #886)', () => {
  it('offers agent versus tab from the focused Dispatch row and cancels without killing', async () => {
    const harness = mountPaneActions(project())
    let closing!: Promise<void>
    await act(async () => { closing = harness.actions.closeFocused() })
    expect(currentCloseConfirmation()?.request.agentOnly?.targets.map(t => t.sessionId)).toEqual(['root'])
    expect(currentCloseConfirmation()?.request.targets.map(t => t.sessionId)).toEqual(['root', 'worker'])
    await act(async () => { resolveCloseConfirmation(false); await closing })
    expect(killOwnedSession).not.toHaveBeenCalled()
    expect(buildVisibleDispatchRows(harness.getState()).map(row => row.sessionId)).toEqual(['root', 'worker'])
    harness.mounted.unmount()
  })

  it('closes only the root after Close Agent, preserving and promoting the live worker', async () => {
    const state = project()
    const refs = makeRefs(state)
    refs.latestRuntimesRef.current = { root: emptyRuntime(), worker: { ...emptyRuntime(), sessionStatus: 'running' } }
    const harness = mountPaneActions(state, { refs })
    let closing!: Promise<boolean>
    await act(async () => { closing = harness.actions.closeSession('root') })
    await act(async () => { resolveCloseConfirmation('agent'); await closing })
    expect(killOwnedSession.mock.calls.map(([owner]) => owner.sessionId)).toEqual(['root'])
    expect(harness.getState().tabs).toEqual([expect.objectContaining({ id: 'project', root: { type: 'leaf', sessionId: 'worker' } })])
    expect(harness.getState().sessions.worker).toBe(state.sessions.worker)
    expect(harness.getState().detachedSessions.worker).toBeUndefined()
    expect(buildVisibleDispatchRows(harness.getState()).map(row => row.sessionId)).toEqual(['worker'])
    expect(harness.spawn).not.toHaveBeenCalled()
    harness.mounted.unmount()
  })

  it('bulk session-only close never kills an unselected detached worker or captures purge undo', async () => {
    const harness = mountPaneActions(project())
    await act(async () => {
      expect(await harness.actions.closeSession('root', {
        preConfirmed: true, captureUndo: false, onlyIf: () => true,
      })).toBe(true)
    })
    expect(killOwnedSession.mock.calls.map(([owner]) => owner.sessionId)).toEqual(['root'])
    expect(harness.getState().sessions.worker).toBeDefined()
    expect(harness.refs.undoStackRef.current.length).toBe(0)
    harness.mounted.unmount()
  })

  it('bulk skips a parent while an unapproved linked child exists', async () => {
    const state = project()
    state.sessions.worker.linkedParentId = 'root'
    const harness = mountPaneActions(state)
    await act(async () => {
      expect(await harness.actions.closeSession('root', {
        preConfirmed: true, captureUndo: false, onlyIf: () => true,
      })).toBe(false)
    })
    expect(killOwnedSession).not.toHaveBeenCalled()
    expect(harness.getState().sessions).toEqual(state.sessions)
    harness.mounted.unmount()
  })

  it('bulk respects current eligibility inside the action instead of the modal snapshot', async () => {
    const harness = mountPaneActions(project())
    await act(async () => {
      expect(await harness.actions.closeSession('root', {
        preConfirmed: true, captureUndo: false, onlyIf: () => false,
      })).toBe(false)
    })
    expect(killOwnedSession).not.toHaveBeenCalled()
    harness.mounted.unmount()
  })

  it('rejects a root-agent grant if that agent starts working under the dialog', async () => {
    const state = project()
    const refs = makeRefs(state)
    refs.latestRuntimesRef.current = { root: emptyRuntime(), worker: emptyRuntime() }
    const harness = mountPaneActions(state, { refs })
    let closing!: Promise<boolean>
    await act(async () => { closing = harness.actions.closeSession('root') })
    refs.latestRuntimesRef.current.root = { ...emptyRuntime(), processActive: true }
    await act(async () => {
      resolveCloseConfirmation('agent')
      expect(await closing).toBe(false)
    })
    expect(killOwnedSession).not.toHaveBeenCalled()
    harness.mounted.unmount()
  })

  it('Close Tab explicitly closes the listed project and captures every detached row', async () => {
    const state = project()
    state.sessions.worker.linkedParentId = 'root'
    const harness = mountPaneActions(state)
    let closing!: Promise<boolean>
    await act(async () => { closing = harness.actions.closeSession('root') })
    await act(async () => { resolveCloseConfirmation(true); expect(await closing).toBe(true) })
    expect(killOwnedSession.mock.calls.map(([owner]) => owner.sessionId)).toEqual(['root', 'worker'])
    expect(harness.getState().tabs).toEqual([])
    expect(harness.getState().sessions).toEqual({})
    expect(harness.refs.undoStackRef.current.peek()).toMatchObject({
      type: 'tab', detachedEntries: [{ meta: state.sessions.worker }],
    })
    harness.mounted.unmount()
  })

  it('undo restores the root and Dispatch order without restarting the surviving worker', async () => {
    const state = project()
    const harness = mountPaneActions(state)
    await act(async () => { await harness.actions.closeSession('root', { preConfirmed: true }) })
    const spawn = vi.fn(async () => 'restored-root')
    const undo = mountUndoCloseAction(harness.getState(), harness.refs, spawn)
    await act(async () => { await undo.actions.undoClose() })
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(undo.getState().tabs[0].root).toEqual({ type: 'leaf', sessionId: 'restored-root' })
    expect(undo.getState().detachedSessions.worker).toEqual(state.detachedSessions.worker)
    expect(undo.getState().sessions.worker).toBe(state.sessions.worker)
    expect(buildVisibleDispatchRows(undo.getState()).map(row => row.sessionId)).toEqual(['restored-root', 'worker'])
    undo.mounted.unmount()
    harness.mounted.unmount()
  })

  it('promotes the next displayed row even when detached records were inserted out of order', async () => {
    const state = project()
    state.sessions.earlier = { cwd: '/project', kind: 'codex' }
    state.detachedSessions.earlier = { ...state.detachedSessions.worker, sessionId: 'earlier', detachedAt: 0 }
    const harness = mountPaneActions(state)
    await act(async () => { await harness.actions.closeSession('root', { preConfirmed: true }) })
    expect(harness.getState().tabs[0].root).toEqual({ type: 'leaf', sessionId: 'earlier' })
    expect(buildVisibleDispatchRows(harness.getState()).map(row => row.sessionId)).toEqual(['earlier', 'worker'])
    expect(killOwnedSession.mock.calls.map(([owner]) => owner.sessionId)).toEqual(['root'])
    harness.mounted.unmount()
  })

  it('undo preserves a later split instead of forcing the old root layout back', async () => {
    const harness = mountPaneActions(project())
    await act(async () => { await harness.actions.closeSession('root', { preConfirmed: true }) })
    const current = harness.getState()
    const edited = {
      ...current,
      sessions: { ...current.sessions, second: { cwd: '/project', kind: 'codex' as const } },
      tabs: current.tabs.map(tab => ({ ...tab, root: {
        type: 'split' as const, direction: 'vertical' as const, ratio: 0.5,
        a: { type: 'leaf' as const, sessionId: 'worker' },
        b: { type: 'leaf' as const, sessionId: 'second' },
      } })),
    }
    const undo = mountUndoCloseAction(edited, harness.refs, vi.fn(async () => 'restored-root'))
    await act(async () => { await undo.actions.undoClose() })
    expect(undo.getState().tabs[0].root).toBe(edited.tabs[0].root)
    expect(undo.getState().detachedSessions['restored-root']).toMatchObject({ projectTabId: 'project' })
    expect(Object.keys(undo.getState().sessions).sort()).toEqual(['restored-root', 'second', 'worker'])
    undo.mounted.unmount()
    harness.mounted.unmount()
  })
})
