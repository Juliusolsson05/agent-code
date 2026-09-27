import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@renderer/app-state/store'
import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SessionMeta } from '@renderer/workspace/types'
import { useSessionActions } from './session'
import { makeRefs } from './testing/paneActionsHarness'
vi.mock('@renderer/workspace/hook/actions/initialHistory', () => ({ loadInitialHistoryForSession: vi.fn(async () => undefined) }))

// #1379: replace and Reload Agents drop any relationship pointer whose target
// is neither live nor in their idMap. A parent that is CLOSED but still on the
// undo stack is neither, so reloading its live child erased the child's link
// and undoing the parent later had nothing to relink: two live panes,
// permanently unlinked. A pointer to what undo can still restore must survive;
// a pointer to what nothing can bring back is still dropped.
const original = useAppStore.getState()
const originalApi = window.api
afterEach(() => { cleanup(); useAppStore.setState(original, true); window.api = originalApi })

const child = (parent: string): SessionMeta => ({
  kind: 'claude', cwd: '/recorded/project', providerSessionId: 'native-child', projectId: 'project', joinedAt: 0,
  linkedParentId: parent, orchestrationParentId: parent, orchestrationRootId: parent,
} as SessionMeta)

function harness(parent: string, restorable: boolean) {
  useAppStore.setState({ workspaceState: { ...original.workspaceState, activeTabId: 'project',
    tabs: [{ id: 'project', title: 'Project' }],
    sessions: { child: child(parent) },
  }, workspaceRuntimes: { child: { ...emptyRuntime(), processStatus: 'started' } } })
  const state = useAppStore.getState().workspaceState
  const refs = makeRefs(state)
  refs.latestRuntimesRef.current = useAppStore.getState().workspaceRuntimes
  if (restorable) {
    refs.undoStackRef.current.push({
      type: 'session', closedAt: Date.now(), sessionId: parent,
      sessionMeta: { kind: 'claude', cwd: '/recorded/project', projectId: 'project', joinedAt: 1 },
    } as never)
  }
  window.api = {
    ...originalApi, spawnSession: vi.fn(async () => ({ sessionId: 'child-next' })), killOwnedSession: vi.fn(async () => true),
    carryGoalLoop: vi.fn(async () => null), carryWorkflowRuns: vi.fn(async () => undefined), controlGoalLoop: vi.fn(async () => null),
  }
  return renderHook(() => useSessionActions(state, useAppStore.getState().setWorkspaceState, useAppStore.getState().setWorkspaceRuntimes, refs))
}

const pointers = (id: string) => {
  const meta = useAppStore.getState().workspaceState.sessions[id]
  return { linkedParentId: meta?.linkedParentId, orchestrationParentId: meta?.orchestrationParentId, orchestrationRootId: meta?.orchestrationRootId }
}

it('keeps a replaced child\'s pointers to a parent that is closed but restorable', async () => {
  const mounted = harness('closed-parent', true)
  await act(async () => {
    expect(await mounted.result.current.replaceSession('/recorded/project', { targetSessionId: 'child', kind: 'claude', resumeSessionId: 'native-child' })).toBe('child-next')
  })
  expect(pointers('child-next')).toEqual({ linkedParentId: 'closed-parent', orchestrationParentId: 'closed-parent', orchestrationRootId: 'closed-parent' })
})

it('keeps the pointers through Reload Agents too', async () => {
  const mounted = harness('closed-parent', true)
  await act(async () => { await mounted.result.current.reloadAgentSessions(true) })
  expect(pointers('child-next')).toEqual({ linkedParentId: 'closed-parent', orchestrationParentId: 'closed-parent', orchestrationRootId: 'closed-parent' })
})

// The control: nothing can bring this parent back, so the dangling link is
// still dropped (the pre-existing, correct behaviour).
it('still drops pointers to a parent that is neither live nor restorable', async () => {
  const mounted = harness('gone-parent', false)
  await act(async () => {
    await mounted.result.current.replaceSession('/recorded/project', { targetSessionId: 'child', kind: 'claude', resumeSessionId: 'native-child' })
  })
  expect(pointers('child-next')).toEqual({ linkedParentId: undefined, orchestrationParentId: undefined, orchestrationRootId: undefined })
})
