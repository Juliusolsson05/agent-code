import { afterEach, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { act, useRef } from 'react'

import { createFakeSessionFeed } from '@renderer/features/sessionFeed/FakeSessionFeed'
import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import { semanticHistoryRow } from '@renderer/session-runtime/semantic/helpers'
import type { SessionId, WorkspaceState } from '@renderer/workspace/types'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'

import { useIpcSubscriptions } from './useIpcSubscriptions'
import { makeWorkspaceRefsForTest as makeRefs } from './testing/workspaceRefsForTest'

// #1290: bootstrap-complete archives a still-open replayed turn with a RAW
// append, while every other archive path (appendSemanticHistory) replaces by
// turnId. A replayed turn T already in history reopens as currentTurn; the
// ledger hides the copy while T is live, then bootstrap-complete appended T
// again: two history rows with one turnId, repeated `sem:T:i` candidate ids
// and duplicate `semantic-block:T:i` React keys.
const originalWindowApi = window.api
afterEach(() => {
  vi.useRealTimers()
  Object.defineProperty(window, 'api', { configurable: true, value: originalWindowApi })
})

const turn = (endedAt: number | null) => ({
  turnId: 'turn-T', source: 'rollout' as const, text: 'replayed answer', blocks: {}, blockOrder: [],
  stopReason: null, usage: null,
  task: { todos: [], doneCount: 0, totalCount: 0, inProgressToolUseIds: [], activeToolNames: [] },
  startedAt: 1, endedAt,
  lookups: { toolCallsById: {}, toolUseIdsInOrder: [], resolvedToolUseIds: [], erroredToolUseIds: [] },
})

it('archives a reopened replayed turn at bootstrap-complete without duplicating it in history', () => {
  vi.useFakeTimers()
  const fake = createFakeSessionFeed()
  const sessionId = 'bootstrap-dedupe' as SessionId
  let workspaceState = { sessions: { [sessionId]: { cwd: '/repo', kind: 'claude' } } } as unknown as WorkspaceState
  let runtimes: Record<SessionId, SessionRuntime> = {
    [sessionId]: {
      ...emptyRuntime(),
      semantic: {
        ...emptyRuntime().semantic,
        // T is already archived AND reopened as the current turn by replay.
        history: [semanticHistoryRow(turn(2) as never)],
        currentTurn: turn(null) as never,
      },
    },
  }
  let refsForTest!: WorkspaceRefs
  const commitRuntimes = (updater: Record<SessionId, SessionRuntime> | ((current: Record<SessionId, SessionRuntime>) => Record<SessionId, SessionRuntime>)): void => {
    runtimes = typeof updater === 'function' ? updater(runtimes) : updater
    refsForTest.latestRuntimesRef.current = runtimes
  }
  function Harness(): React.JSX.Element {
    const refs = useRef<WorkspaceRefs | null>(null)
    if (refs.current === null) {
      refs.current = makeRefs(workspaceState)
      refs.current.latestRuntimesRef.current = runtimes
      refsForTest = refs.current
    }
    useIpcSubscriptions(fake, refs.current, updater => {
      workspaceState = typeof updater === 'function' ? updater(workspaceState) : updater
      refs.current!.stateRef.current = workspaceState
      refs.current!.latestStateRef.current = workspaceState
    }, commitRuntimes, () => {}, () => {})
    return <div />
  }
  Object.defineProperty(window, 'api', { configurable: true, value: { gitWorktrees: vi.fn(async () => ({ ok: false })) } })
  render(<Harness />)

  // A replay burst, then quiet: the bootstrap-complete reconciler runs.
  act(() => {
    fake.emitJsonlEntries({ sessionId, entries: [{ file: '/s/claude.jsonl', entry: { type: 'user', uuid: 'u1', message: { role: 'user', content: 'hi' }, timestamp: '2026-09-27T00:00:00.000Z' } as never }] })
  })
  act(() => { vi.advanceTimersByTime(1_000) })

  const semantic = runtimes[sessionId]!.semantic
  expect(semantic.currentTurn).toBeNull()
  expect(semantic.history.map(row => row.turnId)).toEqual(['turn-T'])
})
