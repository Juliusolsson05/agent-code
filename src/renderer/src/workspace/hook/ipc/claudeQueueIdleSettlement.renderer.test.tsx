import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { act, useRef } from 'react'

import { createFakeSessionFeed } from '@renderer/features/sessionFeed/FakeSessionFeed'
import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import type { SessionId, WorkspaceState } from '@renderer/workspace/types'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'

import { useIpcSubscriptions } from './useIpcSubscriptions'
import { makeWorkspaceRefsForTest as makeRefs } from './testing/workspaceRefsForTest'

// #677: Claude queue debt settles only in markStaleWhenIdle, and its one live
// call site was a semantic event that arrives while the session is ALREADY
// idle. When the turn's last semantic event lands while the process is still
// active and the process then goes idle, nothing settled: a queue chip for an
// item that already left stayed on screen until the next turn, or forever for
// a session with no next turn. These drive the real subscriptions with the
// issue's exact carrier sequence.
const originalWindowApi = window.api
afterEach(() => {
  vi.useRealTimers()
  Object.defineProperty(window, 'api', { configurable: true, value: originalWindowApi })
})

// Read, not imported: the fixture sits outside the web tsconfig's file list.
const fixture = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../../../../../testing/fixtures/queue-operations/exact-remove-after-open-dequeue-debt.json'),
  'utf8',
)) as { events: Array<{ op: string; content?: string; timestamp: string }> }

const NOTIFICATION = '<task-notification>\n<task-id>t-1</task-id>\n<status>completed</status>\n</task-notification>'
const PROMPT = 'queued prompt'

const op = (uuid: string, operation: string, content: string | undefined, second: number) => ({
  file: '/s/claude.jsonl',
  entry: {
    type: 'queue-operation', uuid, operation, ...(content === undefined ? {} : { content }),
    timestamp: `2026-09-27T00:00:${String(second).padStart(2, '0')}.000Z`,
  } as never,
})

let mounts = 0
function mount(initial: Partial<SessionRuntime> = {}) {
  vi.useFakeTimers()
  const fake = createFakeSessionFeed()
  // A fresh id per test: the reconciler's per-session state is module-level
  // (claudeQueueBySession), so a shared id would carry one test's queue into
  // the next.
  const sessionId = `queue-idle-${++mounts}` as SessionId
  let workspaceState = { sessions: { [sessionId]: { cwd: '/repo', kind: 'claude' } } } as unknown as WorkspaceState
  let runtimes: Record<SessionId, SessionRuntime> = { [sessionId]: { ...emptyRuntime(), ...initial } }
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
  return { fake, sessionId, runtime: () => runtimes[sessionId]! }
}

/** Steps 1-3 of the issue: N and P queued, a content-free remove opens
 *  removeDebt, and an exact remove retires P while leaving that debt open. */
function strandDebt(fake: ReturnType<typeof createFakeSessionFeed>, sessionId: SessionId) {
  act(() => {
    fake.emitJsonlEntries({ sessionId, entries: [
      op('q1', 'enqueue', NOTIFICATION, 1),
      op('q2', 'enqueue', PROMPT, 2),
      op('q3', 'remove', undefined, 3),
      op('q4', 'remove', PROMPT, 4),
    ] })
  })
}

const visible = (runtime: SessionRuntime) =>
  runtime.queuedMessages.filter(item => !(item as { stale?: boolean }).stale).map(item => item.content)

it('settles open queue debt when the process goes idle after the last semantic event', () => {
  const { fake, sessionId, runtime } = mount()
  act(() => { fake.emitProcessState({ sessionId, active: true, status: 'Working' }) })
  strandDebt(fake, sessionId)
  // Step 4: the turn's final semantic event arrives while the process is
  // still active, so the semantic idle guard does not fire.
  act(() => { fake.emitSemantic({ sessionId, event: { type: 'turn_completed', ts: Date.now() } as never }) })
  act(() => { vi.advanceTimersByTime(50) })
  expect(visible(runtime())).toEqual([NOTIFICATION])

  // Step 5: process idle. The remaining debt must settle.
  act(() => { fake.emitProcessState({ sessionId, active: false }) })
  expect(visible(runtime())).toEqual([])

})

// The settlement must be committed to the reconciler's own state, not only
// painted. A committed `user` entry re-projects the queue from that state
// while dequeue debt is open, so an uncommitted settlement would bring the
// departed notification back on the very next transcript line.
it('commits the process-idle settlement to the reconciler state', () => {
  const { fake, sessionId, runtime } = mount()
  act(() => { fake.emitProcessState({ sessionId, active: true, status: 'Working' }) })
  act(() => {
    fake.emitJsonlEntries({ sessionId, entries: [
      op('d1', 'enqueue', NOTIFICATION, 1),
      op('d2', 'enqueue', PROMPT, 2),
      op('d3', 'dequeue', undefined, 3),
      op('d4', 'remove', PROMPT, 4),
    ] })
  })
  act(() => { fake.emitProcessState({ sessionId, active: false }) })
  expect(visible(runtime())).toEqual([])
  act(() => {
    fake.emitJsonlEntries({ sessionId, entries: [{
      file: '/s/claude.jsonl',
      entry: { type: 'user', uuid: 'u-later', message: { role: 'user', content: 'an unrelated later prompt' }, timestamp: '2026-09-27T00:00:09.000Z' } as never,
    }] })
  })
  expect(visible(runtime())).toEqual([])
})

it('does not settle while the process is still active', () => {
  const { fake, sessionId, runtime } = mount()
  act(() => { fake.emitProcessState({ sessionId, active: true, status: 'Working' }) })
  strandDebt(fake, sessionId)
  act(() => { fake.emitProcessState({ sessionId, active: true, status: 'Still working' }) })
  expect(visible(runtime())).toEqual([NOTIFICATION])
})

// Bootstrap: production replay delivers no semantic events, so the recorded
// run that ends with 3 pending items and debt.count = 3 (reconcile.test.ts
// pins those numbers on the reducer) kept all three chips after replay.
it('settles the recorded open-debt replay at bootstrap-complete', () => {
  const { fake, sessionId, runtime } = mount({ bootstrapping: true })
  act(() => {
    fake.emitJsonlEntries({
      sessionId,
      entries: fixture.events.map((event, index) => op(`r${index}`, event.op, event.content, 0)).map((entry, index) => ({
        ...entry, entry: { ...(entry.entry as object), timestamp: fixture.events[index]!.timestamp } as never,
      })),
    })
  })
  expect(runtime().queuedMessages).toHaveLength(3)
  act(() => { vi.advanceTimersByTime(1_000) })
  expect(runtime().bootstrapping).toBe(false)
  expect(visible(runtime())).toEqual([])

  // Committed, not only painted (see the process-idle commit test).
  act(() => {
    fake.emitJsonlEntries({ sessionId, entries: [{
      file: '/s/claude.jsonl',
      entry: { type: 'user', uuid: 'u-after-replay', message: { role: 'user', content: 'a later prompt' }, timestamp: '2026-09-27T00:00:09.000Z' } as never,
    }] })
  })
  expect(visible(runtime())).toEqual([])
})

it('leaves the queue alone at bootstrap-complete while the process is live', () => {
  const { fake, sessionId, runtime } = mount({ bootstrapping: true, processActive: true })
  strandDebt(fake, sessionId)
  act(() => { vi.advanceTimersByTime(1_000) })
  expect(visible(runtime())).toEqual([NOTIFICATION])
})

// #1396 review a: idleness is not proof the queue drained. Between turns the
// spinner can read idle while Claude still holds N2, and a resumed pane's
// first replay-quiet tick starts from idle defaults. With no open debt to
// account for N2, neither site may touch it.
const FIRST = 'first queued prompt'
const SECOND = 'second queued prompt'
function deliverFirstKeepSecond(fake: ReturnType<typeof createFakeSessionFeed>, sessionId: SessionId) {
  act(() => {
    fake.emitJsonlEntries({ sessionId, entries: [
      op('k1', 'enqueue', FIRST, 1),
      op('k2', 'enqueue', SECOND, 2),
      op('k3', 'dequeue', undefined, 3),
      { file: '/s/claude.jsonl', entry: { type: 'user', uuid: 'k-user', message: { role: 'user', content: FIRST }, timestamp: '2026-09-27T00:00:04.000Z' } as never },
    ] })
  })
}

it('leaves a genuinely queued item live when the process goes idle between turns', () => {
  const { fake, sessionId, runtime } = mount()
  act(() => { fake.emitProcessState({ sessionId, active: true, status: 'Working' }) })
  deliverFirstKeepSecond(fake, sessionId)
  expect(visible(runtime())).toEqual([SECOND])
  act(() => { fake.emitProcessState({ sessionId, active: false }) })
  expect(visible(runtime())).toEqual([SECOND])
})

it('leaves a genuinely queued item live at bootstrap-complete', () => {
  const { fake, sessionId, runtime } = mount({ bootstrapping: true })
  deliverFirstKeepSecond(fake, sessionId)
  act(() => { vi.advanceTimersByTime(1_000) })
  expect(runtime().bootstrapping).toBe(false)
  expect(visible(runtime())).toEqual([SECOND])
})

// The stream-phase half of each guard: a spinner that reads inactive while
// the semantic stream is still responding is not idle, even with the debt
// covering everything.
it('does not settle on a process-idle flip while the stream is still responding', () => {
  const { fake, sessionId, runtime } = mount({ streamPhase: 'responding' })
  act(() => { fake.emitProcessState({ sessionId, active: true, status: 'Working' }) })
  strandDebt(fake, sessionId)
  act(() => { fake.emitProcessState({ sessionId, active: false }) })
  expect(visible(runtime())).toEqual([NOTIFICATION])
})

it('does not settle at bootstrap-complete while the stream is still responding', () => {
  const { fake, sessionId, runtime } = mount({ bootstrapping: true, streamPhase: 'responding' })
  strandDebt(fake, sessionId)
  act(() => { vi.advanceTimersByTime(1_000) })
  expect(visible(runtime())).toEqual([NOTIFICATION])
})
