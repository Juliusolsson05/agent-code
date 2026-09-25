import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { emptyRuntime, type SessionRuntime } from '@renderer/session-runtime/state'
import type { SessionId, WorkspaceState } from '@renderer/workspace/types'
import { oneLaneStage } from '@renderer/workspace/testing/stageFixtures'

import { useSessionActions } from './session'
import { makeRefs, stateWriter } from './testing/paneActionsHarness'

// #770. The feed-debug flush cursors live OUTSIDE the runtime — they are
// per-session bookkeeping deliberately kept off the store so a busy agent does
// not re-render the workspace on every persisted batch. A soft reload rebuilds
// the runtime and restarts `feedDebugNextId` at 1, and nothing in that reset
// reaches the refs. Left behind, `selectFeedDebugAppendBatch` filters every
// entry of the new generation as `id <= lastPersistedId`, and the session
// stops persisting feed-debug for the rest of the run — precisely when someone
// is reloading BECAUSE the feed went wrong.

const SESSION = 'agent' as SessionId

const originalApi = window.api
beforeEach(() => {
  // The durable-session arm loads history after resetting. Only the two calls
  // that arm makes are stubbed; everything else is the real action.
  window.api = {
    ...(originalApi ?? {}),
    loadInitialHistory: vi.fn(async () => ({
      entries: [], totalEntries: 0, oldestMarker: null, hasOlder: false, hasMore: false,
    })),
  } as unknown as typeof window.api
})
afterEach(() => { window.api = originalApi })

function runtimeStore(initial: Record<SessionId, SessionRuntime>, refs: { latestRuntimesRef: { current: Record<SessionId, SessionRuntime> } }) {
  let runtimes = initial
  refs.latestRuntimesRef.current = runtimes
  return {
    get: () => runtimes,
    set: (next: Record<SessionId, SessionRuntime> | ((prev: Record<SessionId, SessionRuntime>) => Record<SessionId, SessionRuntime>)) => {
      runtimes = typeof next === 'function' ? next(runtimes) : next
      refs.latestRuntimesRef.current = runtimes
    },
  }
}

function harness(providerSessionId?: string) {
  const state: WorkspaceState = {
    tabs: [{ id: 'project', title: 'project' }],
    activeTabId: 'project',
    stage: oneLaneStage(SESSION),
    sessions: {
      [SESSION]: {
        cwd: '/repo',
        kind: 'claude',
        projectId: 'project',
        joinedAt: 0,
        ...(providerSessionId ? { providerSessionId, providerSessionIdSource: 'jsonl-entry' as const } : {}),
      },
    },
    pinnedSessionIds: [],
  }
  const refs = makeRefs(state)
  const writer = stateWriter(state, refs)
  const runtimes = runtimeStore(
    { [SESSION]: { ...emptyRuntime(), feedDebugNextId: 4_813, feedDebugEpochMs: 1_000 } },
    refs,
  )
  refs.persistedFeedDebugIdRef.current[SESSION] = 4_812
  refs.inFlightFeedDebugIdRef.current[SESSION] = 4_812
  const { result } = renderHook(() => useSessionActions(
    { activeTabId: state.activeTabId, sessions: state.sessions, tabs: state.tabs },
    writer.setState,
    runtimes.set,
    refs,
  ))
  return { refs, result, runtimes: runtimes.get }
}

it('drops the flush cursors when the reload restarts the ids', async () => {
  const { refs, result, runtimes } = harness('claude-native-id')

  await act(async () => { await result.current.softReloadAgentView(SESSION) })

  // The runtime's ids restarted…
  expect(runtimes()[SESSION]!.feedDebugNextId).toBe(1)
  expect(runtimes()[SESSION]!.feedDebugEpochMs).toBeNull()
  // …so a cursor at 4,812 would swallow every entry of the new generation.
  expect(refs.persistedFeedDebugIdRef.current[SESSION]).toBeUndefined()
  expect(refs.inFlightFeedDebugIdRef.current[SESSION]).toBeUndefined()
})

it('KEEPS them when the reload does not restart the ids', async () => {
  // The two arms of soft reload are not the same operation. Without a durable
  // provider transcript the reload is deliberately non-destructive: it keeps
  // the runtime and only marks the transcript disconnected. The ids therefore
  // keep counting up, the cursors are still true, and clearing them would make
  // the renderer re-send everything it had already persisted.
  //
  // This is the test that stops the fix from being "delete the cursors on
  // anything called soft reload".
  const { refs, result, runtimes } = harness()

  await act(async () => { await result.current.softReloadAgentView(SESSION) })

  expect(runtimes()[SESSION]!.feedDebugNextId).toBe(4_813)
  expect(refs.persistedFeedDebugIdRef.current[SESSION]).toBe(4_812)
  expect(refs.inFlightFeedDebugIdRef.current[SESSION]).toBe(4_812)
})

it('leaves another session’s cursors alone', async () => {
  const { refs, result } = harness('claude-native-id')
  refs.persistedFeedDebugIdRef.current['other' as SessionId] = 77

  await act(async () => { await result.current.softReloadAgentView(SESSION) })

  expect(refs.persistedFeedDebugIdRef.current['other' as SessionId]).toBe(77)
})
