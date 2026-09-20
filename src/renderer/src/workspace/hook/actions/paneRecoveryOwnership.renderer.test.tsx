import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MutableRefObject } from 'react'

import { UndoCloseStack } from '@renderer/lib/undoClose'
import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import type { SessionActions } from '@renderer/workspace/hook/actions/session'
import type { SessionId, WorkspaceState } from '@renderer/workspace/types'
import {
  __resetCloseConfirmationForTests,
  currentCloseConfirmation,
  resolveCloseConfirmation,
} from '@renderer/workspace/closeConfirmationBroker'

import { usePaneActions } from './pane'
import { oneLaneStage } from '@renderer/workspace/testing/stageFixtures'

const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api')

afterEach(() => {
  __resetCloseConfirmationForTests()
  if (originalApiDescriptor) {
    Object.defineProperty(window, 'api', originalApiDescriptor)
  } else {
    Reflect.deleteProperty(window, 'api')
  }
})

function ref<T>(current: T): MutableRefObject<T> {
  return { current }
}

function renderPaneActionsHarness(
  initialState: WorkspaceState,
  initialRuntimes: Record<SessionId, SessionRuntime>,
  killOwnedResult = true,
) {
  let state = initialState
  let runtimes = initialRuntimes
  const refs = {
    stateRef: ref(state),
    latestStateRef: ref(state),
    latestRuntimesRef: ref(runtimes),
    seenUuidsRef: ref<Record<SessionId, Set<string>>>({}),
    latestScreenRef: ref<Record<SessionId, string>>({}),
    undoStackRef: ref(new UndoCloseStack()),
    // Close operations release a pending bootstrap debounce for each session
    // they end, as sessionActions.killSession always did (#886 round 2).
    bootstrapTimersRef: ref(new Map()),
  } as unknown as WorkspaceRefs
  const setState = (next: WorkspaceState | ((prev: WorkspaceState) => WorkspaceState)) => {
    state = typeof next === 'function' ? next(state) : next
    refs.stateRef.current = state
    refs.latestStateRef.current = state
  }
  const setRuntimes = (
    next: Record<SessionId, SessionRuntime> |
      ((prev: Record<SessionId, SessionRuntime>) => Record<SessionId, SessionRuntime>),
  ) => {
    runtimes = typeof next === 'function' ? next(runtimes) : next
    refs.latestRuntimesRef.current = runtimes
  }
  const killOwnedSession = vi.fn(async () => killOwnedResult)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { killOwnedSession },
  })
  const sessionActions = {
    killSession: vi.fn(),
  } as unknown as SessionActions
  const hook = renderHook(() => usePaneActions(
    state,
    setState,
    setRuntimes,
    vi.fn(),
    vi.fn(),
    refs,
    vi.fn(),
    vi.fn(),
    vi.fn(),
    sessionActions,
  ))

  return {
    ...hook,
    refs,
    killOwnedSession,
    getState: () => state,
    getRuntimes: () => runtimes,
  }
}

describe('pane recovery ownership', () => {
  it('closes an ownership-conflict leaf without killing the unrelated main backend', async () => {
    const sessionId = 'conflicted-session'
    let state = {
      tabs: [{
        id: 'tab-1',
        title: 'Project',
      }],
      activeTabId: 'tab-1',
      sessions: {
        // Filed under the project: a close addresses a session through its
        // own `projectId` (#992), so a row naming no project is unowned and
        // closeSession has nothing to act on — the fixture would pass the type
        // check and then silently test a no-op.
        [sessionId]: { cwd: '/tmp/project', kind: 'claude' as const, projectId: 'tab-1', joinedAt: 0 },
      },
      pinnedSessionIds: [],
      stage: oneLaneStage(sessionId),
    } as WorkspaceState
    let runtimes: Record<SessionId, SessionRuntime> = {
      [sessionId]: {
        ...emptyRuntime(),
        processStatus: 'failed',
        processError: 'owned elsewhere',
        recoveryFailureCode: 'ownership-conflict',
      },
    }
    const refs = {
      stateRef: ref(state),
      latestStateRef: ref(state),
      latestRuntimesRef: ref(runtimes),
      seenUuidsRef: ref<Record<SessionId, Set<string>>>({}),
      latestScreenRef: ref<Record<SessionId, string>>({}),
      undoStackRef: ref(new UndoCloseStack()),
      bootstrapTimersRef: ref(new Map()),
    } as unknown as WorkspaceRefs
    const setState = (next: WorkspaceState | ((prev: WorkspaceState) => WorkspaceState)) => {
      state = typeof next === 'function' ? next(state) : next
      refs.stateRef.current = state
      refs.latestStateRef.current = state
    }
    const setRuntimes = (
      next: Record<SessionId, SessionRuntime> |
        ((prev: Record<SessionId, SessionRuntime>) => Record<SessionId, SessionRuntime>),
    ) => {
      runtimes = typeof next === 'function' ? next(runtimes) : next
      refs.latestRuntimesRef.current = runtimes
    }
    const killOwnedSession = vi.fn(async () => false)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { killOwnedSession },
    })
    const sessionActions = {
      killSession: vi.fn(),
    } as unknown as SessionActions

    const { result } = renderHook(() => usePaneActions(
      state,
      setState,
      setRuntimes,
      vi.fn(),
      vi.fn(),
      refs,
      vi.fn(),
      vi.fn(),
      vi.fn(),
      sessionActions,
    ))

    await act(async () => {
      await result.current.closeSession(sessionId)
    })

    // Renderer cleanup is still allowed, but the destructive request carries
    // the pane's durable owner tuple and main rejects it atomically because the
    // conflicting backend does not match. A generic id-only kill must never be
    // reachable from this path.
    expect(killOwnedSession).toHaveBeenCalledWith({
      sessionId,
      kind: 'claude',
      cwd: '/tmp/project',
    })
    expect(state.sessions[sessionId]).toBeUndefined()
    expect(state.tabs).toEqual([])
    expect(runtimes[sessionId]).toBeUndefined()
  })

  it('closes every session of a project, parked ones included, as one transaction with one undo entry', async () => {
    const paneId = 'visible-pane'
    const detachedId = 'detached-child'
    const state = {
      tabs: [{
        id: 'tab-1',
        title: 'Project',
      }],
      activeTabId: 'tab-1',
      sessions: {
        [paneId]: { cwd: '/tmp/project', kind: 'claude' as const, projectId: 'tab-1', joinedAt: 0 },
        [detachedId]: { cwd: '/tmp/project', kind: 'codex' as const, projectId: 'tab-1', joinedAt: 123 },
      },
      pinnedSessionIds: [],
      stage: oneLaneStage(paneId),
    } as WorkspaceState
    const harness = renderPaneActionsHarness(state, {
      [paneId]: emptyRuntime(),
      [detachedId]: emptyRuntime(),
    })

    // Close Tab takes the parked agent no lane shows along with the one on
    // screen, so this is a two-session close and the gate must ask. Answering
    // it here is not test ceremony — it is the assertion that the dialog names
    // BOTH sessions. Before the gate counted parked sessions, a tab close
    // reported one target and silently took two.
    //
    // Re-based with #992. This used to be reached by closing the tab's LAST
    // TILE LEAF, which took the tab's detached rows with it because the tile
    // tree could not be left empty. A session close is session-scoped now —
    // closing `visible-pane` alone would leave the project holding its parked
    // agent — so the whole-project transaction is Close Tab's, and only its.
    let closing: Promise<void> | undefined
    await act(async () => {
      closing = harness.result.current.closeTab('tab-1')
      await Promise.resolve()
    })
    expect(currentCloseConfirmation()?.request.targets.map(t => t.sessionId).sort())
      .toEqual([detachedId, paneId].sort())
    await act(async () => {
      resolveCloseConfirmation(true)
      await closing
    })

    // WHY this assertion covers more than renderer cleanup: once the project
    // disappears, a session still naming it is unowned. The save-time prune is
    // right to drop it, so the close must first make it part of the same
    // destructive transaction and Undo Close snapshot.
    expect(harness.killOwnedSession).toHaveBeenCalledTimes(2)
    expect(harness.killOwnedSession).toHaveBeenCalledWith({
      sessionId: detachedId,
      kind: 'codex',
      cwd: '/tmp/project',
    })
    expect(harness.getState().tabs).toEqual([])
    expect(harness.getState().sessions).toEqual({})
    expect(harness.getRuntimes()).toEqual({})

    const undoEntry = harness.refs.undoStackRef.current.pop()
    expect(undoEntry?.type).toBe('tab')
    if (undoEntry?.type === 'tab') {
      // sessionId is the lineage anchor undo publishes when a session is
      // restored, so older entries naming it keep resolving (#886 finding 4).
      // The row carries its own place (`joinedAt: 123`), so it returns to it.
      expect(undoEntry.sessions).toEqual([
        { sessionId: paneId, meta: state.sessions[paneId] },
        { sessionId: detachedId, meta: state.sessions[detachedId] },
      ])
    }
  })

})
