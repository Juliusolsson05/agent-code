import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { act } from 'react'
import { useRef } from 'react'
import type { MutableRefObject } from 'react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { createFakeSessionFeed } from '@renderer/features/sessionFeed/FakeSessionFeed'
import { UndoCloseStack } from '@renderer/lib/undoClose'
import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import {
  MAX_LIVE_ENTRIES,
  TRIM_TO_LIVE_ENTRIES,
} from '@renderer/session-runtime/liveEntryWindow'
import type { SessionId, WorkspaceState } from '@renderer/workspace/types'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'

import { useIpcSubscriptions } from './useIpcSubscriptions'

const originalWindowApi = window.api

afterEach(() => {
  // The semantic burst test installs the smallest Electron bridge needed by
  // the ghost path and uses fake time for the 100 ms cadence. Restore both even
  // when an assertion fails so one backpressure regression cannot cascade into
  // misleading failures in the otherwise bridge-free subscription tests.
  vi.useRealTimers()
  if (originalWindowApi === undefined) {
    Reflect.deleteProperty(window, 'api')
  } else {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: originalWindowApi,
    })
  }
})

// Proof test for the phase-0 decoupling: the subscription hub must consume
// session events from an injected SessionFeed — NOT from window.api — so the
// same hook can be driven by IPC (desktop), WebSocket (remote client), or
// this fake (no Electron anywhere in this test). If someone reintroduces a
// direct `window.api.onSession*` call for a feed-covered event, this test
// crashes on the undefined bridge, which is exactly the regression signal
// we want.
//
// The harness builds the minimal honest WorkspaceRefs/state the handlers
// actually touch; it is NOT a full workspace. Desktop-only side channels
// (ghostAppend, gitWorktrees) are deliberately outside the feed and only
// fire on paths this test does not drive (ghost changes, session-started
// worktree refresh).

function makeRefs(state: WorkspaceState): WorkspaceRefs {
  // Plain object refs are fine outside React's render cycle — the hook only
  // ever reads/writes `.current`.
  const ref = <T,>(v: T): MutableRefObject<T> => ({ current: v })
  return {
    stateRef: ref(state),
    latestStateRef: ref(state),
    latestRuntimesRef: ref({}),
    latestTileTabsRef: ref(null),
    dangerousAgentsRef: ref(false),
    useProxyStreamingRef: ref(false),
    defaultBuiltInMcpDomainsRef: ref([]),
    seenUuidsRef: ref({}),
    latestScreenRef: ref({}),
    undoStackRef: ref(new UndoCloseStack()),
    bootstrapTimersRef: ref(new Map()),
    persistedFeedDebugIdRef: ref({}),
    inFlightFeedDebugIdRef: ref({}),
    paneToastTimers: ref({}),
    saveTimerRef: ref(null),
    bootRef: ref(false),
  }
}

describe('useIpcSubscriptions with an injected SessionFeed', () => {
  it('hands a legacy queued prompt from the queue strip to its durable feed row across bursts', () => {
    const fake = createFakeSessionFeed()
    const sessionId = 'recorded-queue-handoff'
    const state = {
      sessions: { [sessionId]: { cwd: '/repo', kind: 'claude' } },
    } as unknown as WorkspaceState
    let runtimes: Record<SessionId, SessionRuntime> = {}
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { gitWorktrees: vi.fn(async () => ({ ok: false })) },
    })
    const bundle = JSON.parse(
      readFileSync(
        resolve(
          process.cwd(),
          'testing/fixtures/rendering-bundles/2026-06-14T14-25-07-012-a8ad1ebb.json',
        ),
        'utf8',
      ),
    ) as { input: { entries: Array<Record<string, unknown>> } }
    const enqueue = bundle.input.entries[7]!
    const remove = bundle.input.entries[8]!
    const durable = bundle.input.entries[13]!

    function Harness(): React.JSX.Element {
      const refs = useRef<WorkspaceRefs | null>(null)
      if (refs.current === null) refs.current = makeRefs(state)
      useIpcSubscriptions(
        fake,
        refs.current,
        () => {},
        updater => {
          runtimes = typeof updater === 'function' ? updater(runtimes) : updater
          refs.current!.latestRuntimesRef.current = runtimes
        },
        () => {},
        () => {},
      )
      return <div />
    }

    render(<Harness />)
    act(() => {
      fake.emitJsonlEntries({
        sessionId,
        entries: [enqueue, remove].map(entry => ({ file: 'recorded.jsonl', entry })),
      })
    })

    // The old content-free remove is deliberately not guessed away at the IPC
    // boundary. Debt survives the watcher burst as a count only; the queue
    // still owns the prompt until its recorded durable identity arrives.
    expect(runtimes[sessionId]?.queuedMessages.map(item => item.content)).toEqual([
      enqueue.content,
    ])

    act(() => {
      fake.emitJsonlEntries({
        sessionId,
        entries: [{ file: 'recorded.jsonl', entry: durable }],
      })
    })

    // One transition, two planes: the queue item retires and the very same raw
    // durable attachment enters the shared feed window. No optimistic copy or
    // prompt clone is manufactured by the handoff.
    expect(runtimes[sessionId]?.queuedMessages).toEqual([])
    expect(runtimes[sessionId]?.entries).toContain(durable)
  })

  it('folds a cumulative semantic burst at preview cadence instead of once per transport event', () => {
    vi.useFakeTimers()
    const fake = createFakeSessionFeed()
    const state = { sessions: {} } as WorkspaceState
    let runtimes: Record<SessionId, SessionRuntime> = {}
    const ghostAppend = vi.fn()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { ghostAppend },
    })

    function Harness(): React.JSX.Element {
      const refs = useRef<WorkspaceRefs | null>(null)
      if (refs.current === null) refs.current = makeRefs(state)
      useIpcSubscriptions(
        fake,
        refs.current,
        () => {},
        updater => {
          runtimes = typeof updater === 'function' ? updater(runtimes) : updater
        },
        () => {},
        () => {},
      )
      return <div />
    }

    const mounted = render(<Harness />)
    act(() => {
      fake.emitSemantic({
        sessionId: 'burst-1',
        event: { type: 'turn_started', turnId: 'turn-1', source: 'proxy', ts: 1 },
      })
      fake.emitSemantic({
        sessionId: 'burst-1',
        event: {
          type: 'block_started',
          turnId: 'turn-1',
          blockIndex: 0,
          kind: 'tool_use',
          toolName: 'apply_patch',
          toolUseId: 'tool-1',
          source: 'proxy',
          ts: 2,
        },
      })
      for (let index = 1; index <= 1_000; index += 1) {
        fake.emitSemantic({
          sessionId: 'burst-1',
          event: {
            type: 'tool_input_delta',
            turnId: 'turn-1',
            blockIndex: 0,
            toolName: 'apply_patch',
            toolUseId: 'tool-1',
            partialJson: 'x',
            inputJsonSoFar: 'x'.repeat(index),
            source: 'proxy',
            ts: index + 2,
          },
        })
      }
    })

    // turn_started + block_started are ordering boundaries and are visible
    // immediately. The 1,000 obsolete input prefixes wait as ONE snapshot.
    expect(runtimes['burst-1']?.semantic.currentTurn?.blocks[0]?.inputJson).toBe('')
    expect(ghostAppend).toHaveBeenCalledTimes(1)

    act(() => {
      vi.advanceTimersByTime(100)
    })

    expect(runtimes['burst-1']?.semantic.currentTurn?.blocks[0]?.inputJson).toBe(
      'x'.repeat(1_000),
    )
    // One initial ghost plus one latest cumulative snapshot. The pre-fix hook
    // invoked IPC 1,001 times here and journaled every growing copy.
    expect(ghostAppend).toHaveBeenCalledTimes(2)

    act(() => {
      fake.emitSemantic({
        sessionId: 'burst-1',
        event: {
          type: 'tool_input_delta',
          turnId: 'turn-1',
          blockIndex: 0,
          toolName: 'apply_patch',
          toolUseId: 'tool-1',
          partialJson: 'y',
          inputJsonSoFar: `${'x'.repeat(1_000)}y`,
          source: 'proxy',
          ts: 1_003,
        },
      })
      fake.emitSemantic({
        sessionId: 'burst-1',
        event: {
          type: 'tool_input_finalized',
          turnId: 'turn-1',
          blockIndex: 0,
          toolName: 'apply_patch',
          toolUseId: 'tool-1',
          inputJson: `${'x'.repeat(1_000)}y`,
          parsed: { patch: 'final' },
          source: 'proxy',
          ts: 1_004,
        },
      })
    })

    // A structural event bypasses the timer but first drains the pending
    // latest delta, so completion can never overtake or later be resurrected
    // by a stale timer callback.
    expect(runtimes['burst-1']?.semantic.currentTurn?.blocks[0]?.inputJson).toBe(
      `${'x'.repeat(1_000)}y`,
    )
    expect(runtimes['burst-1']?.semantic.currentTurn?.blocks[0]?.parsedInput).toEqual({
      patch: 'final',
    })

    mounted.unmount()
  })

  it('folds a screen event from the fake feed into session runtimes', () => {
    const fake = createFakeSessionFeed()
    const state = { sessions: {} } as WorkspaceState
    let runtimes: Record<SessionId, SessionRuntime> = {}

    function Harness(): React.JSX.Element {
      const refs = useRef<WorkspaceRefs | null>(null)
      if (refs.current === null) refs.current = makeRefs(state)
      useIpcSubscriptions(
        fake,
        refs.current,
        updater => {
          // setState is unused by the screen path; apply for completeness.
          void updater
        },
        updater => {
          runtimes = typeof updater === 'function' ? updater(runtimes) : updater
        },
        (sessionId, patch) => {
          runtimes = {
            ...runtimes,
            [sessionId]: { ...(runtimes[sessionId] as SessionRuntime), ...patch },
          }
        },
        () => {},
      )
      return <div />
    }

    render(<Harness />)

    act(() => {
      fake.emitScreen({
        sessionId: 's1',
        plain: 'hello world',
        markdown: 'hello world',
        recent: 'hello world',
        recentMarkdown: 'hello world',
        picker: { visible: false, items: [] },
      })
    })

    expect(runtimes.s1?.screen).toBe('hello world')
    expect(runtimes.s1?.recentScreen).toBe('hello world')
  })

  it('treats provider readiness as versioned state, never as process activity', () => {
    const fake = createFakeSessionFeed()
    const state = {
      sessions: { s1: { cwd: '/repo', kind: 'claude' } },
    } as unknown as WorkspaceState
    let runtimes: Record<SessionId, SessionRuntime> = {}
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { gitWorktrees: vi.fn(async () => ({ ok: false })) },
    })

    function Harness(): React.JSX.Element {
      const refs = useRef<WorkspaceRefs | null>(null)
      if (refs.current === null) refs.current = makeRefs(state)
      useIpcSubscriptions(
        fake,
        refs.current,
        () => {},
        updater => {
          runtimes = typeof updater === 'function' ? updater(runtimes) : updater
          refs.current!.latestRuntimesRef.current = runtimes
        },
        (sessionId, patch) => {
          const current = runtimes[sessionId] ?? emptyRuntime()
          runtimes = { ...runtimes, [sessionId]: { ...current, ...patch } }
          refs.current!.latestRuntimesRef.current = runtimes
        },
        () => {},
      )
      return <div />
    }

    render(<Harness />)

    act(() => {
      fake.emitStarted({ sessionId: 's1', kind: 'claude', projectDir: '/repo' })
      fake.emitProcessState({ sessionId: 's1', active: false })
    })
    expect(runtimes.s1).toMatchObject({
      processStatus: 'started',
      inputReady: false,
      inputReadinessRevision: -1,
    })

    act(() => {
      fake.emitInputReadiness({
        sessionId: 's1',
        input: { ready: true, revision: 2, reason: 'ready' },
      })
      fake.emitInputReadiness({
        sessionId: 's1',
        input: { ready: false, revision: 1, reason: 'replaying-history' },
      })
      fake.emitProcessState({ sessionId: 's1', active: true, status: 'Working' })
    })
    expect(runtimes.s1).toMatchObject({
      inputReady: true,
      inputReadinessRevision: 2,
      processActive: true,
    })

    act(() => {
      fake.emitInputReadiness({
        sessionId: 's1',
        input: { ready: false, revision: 3, reason: 'provider-not-ready' },
      })
    })
    expect(runtimes.s1).toMatchObject({
      inputReady: false,
      inputReadinessRevision: 3,
    })
  })

  it('quarantines every content and lifecycle channel after an ownership conflict', () => {
    const fake = createFakeSessionFeed()
    const state = {
      sessions: { s1: { cwd: '/repo', kind: 'claude' } },
    } as unknown as WorkspaceState
    const conflictedRuntime: SessionRuntime = {
      ...emptyRuntime(),
      processStatus: 'failed',
      processError: 'Session id is owned by another workspace',
      recoveryFailureCode: 'ownership-conflict',
      draftInput: 'renderer-local draft survives',
    }
    let runtimes: Record<SessionId, SessionRuntime> = { s1: conflictedRuntime }
    let refsForAssertion: WorkspaceRefs | null = null

    function Harness(): React.JSX.Element {
      const refs = useRef<WorkspaceRefs | null>(null)
      if (refs.current === null) {
        refs.current = makeRefs(state)
        refs.current.latestRuntimesRef.current = runtimes
        refsForAssertion = refs.current
      }
      useIpcSubscriptions(
        fake,
        refs.current,
        () => {},
        updater => {
          runtimes = typeof updater === 'function' ? updater(runtimes) : updater
          refs.current!.latestRuntimesRef.current = runtimes
        },
        (sessionId, patch) => {
          const current = runtimes[sessionId] ?? emptyRuntime()
          runtimes = { ...runtimes, [sessionId]: { ...current, ...patch } }
          refs.current!.latestRuntimesRef.current = runtimes
        },
        () => {},
      )
      return <div />
    }

    render(<Harness />)
    act(() => {
      fake.emitStarted({ sessionId: 's1', kind: 'claude', projectDir: '/wrong-repo' })
      fake.emitInputReadiness({
        sessionId: 's1',
        input: { ready: true, revision: 99, reason: 'ready' },
      })
      fake.emitScreen({
        sessionId: 's1',
        plain: 'wrong backend content',
        markdown: 'wrong backend content',
        recent: 'wrong backend content',
        recentMarkdown: 'wrong backend content',
        picker: { visible: false, items: [] },
      })
      fake.emitProcessState({ sessionId: 's1', active: true, status: 'Working' })
      fake.emitSemantic({
        sessionId: 's1',
        event: { type: 'turn_started', turnId: 'wrong-turn', source: 'proxy', ts: 1 },
      })
      fake.emitExit({ sessionId: 's1', exitCode: 17 })
    })

    // WHY reference equality matters here: merely restoring the visible error
    // after folding a wrong event would still transiently ingest another
    // workspace's text and mutate hidden semantic/debug state. Quarantine must
    // return before every state/ref write until matching ownership is proven.
    expect(runtimes.s1).toBe(conflictedRuntime)
    expect(refsForAssertion!.latestScreenRef.current.s1).toBeUndefined()
  })

  it('marks the runtime exited when the fake feed emits exit', () => {
    const fake = createFakeSessionFeed()
    const state = { sessions: {} } as WorkspaceState
    let runtimes: Record<SessionId, SessionRuntime> = {}

    function Harness(): React.JSX.Element {
      const refs = useRef<WorkspaceRefs | null>(null)
      if (refs.current === null) refs.current = makeRefs(state)
      useIpcSubscriptions(
        fake,
        refs.current,
        () => {},
        updater => {
          runtimes = typeof updater === 'function' ? updater(runtimes) : updater
        },
        () => {},
        () => {},
      )
      return <div />
    }

    render(<Harness />)

    act(() => {
      fake.emitExit({ sessionId: 's1', exitCode: 0 })
    })

    expect(runtimes.s1?.exited).toBe(0)
    expect(runtimes.s1?.processActive).toBe(false)
  })

  // Live entries window (#375 part B) — the burst handler applying a trim
  // plan. The pure planner's constraint matrix is covered in
  // session-runtime/entries.test.ts; this exercises the wiring: window
  // bound applied, totalEntries NEVER decremented, pagination re-anchored,
  // and the asymmetric dedupe keeping a replay of trimmed rows off the tail.
  it('trims the live window past MAX_LIVE_ENTRIES without touching totalEntries, and blocks tail replay of trimmed rows', () => {
    const fake = createFakeSessionFeed()
    const state = { sessions: {} } as WorkspaceState
    let runtimes: Record<SessionId, SessionRuntime> = {}

    function Harness(): React.JSX.Element {
      const refs = useRef<WorkspaceRefs | null>(null)
      if (refs.current === null) refs.current = makeRefs(state)
      useIpcSubscriptions(
        fake,
        refs.current,
        () => {},
        updater => {
          runtimes = typeof updater === 'function' ? updater(runtimes) : updater
        },
        () => {},
        () => {},
      )
      return <div />
    }

    render(<Harness />)

    // A distinct sessionId per test: the trimmed-uuid bookkeeping is
    // module-level (mirroring seenUuids semantics), so sessions must not be
    // shared across test cases.
    const sessionId = 'win-1'
    const total = MAX_LIVE_ENTRIES + 100
    const baseTs = Date.parse('2026-07-09T10:00:00.000Z')
    // Claude-shaped user lines: no session meta exists for this pane, so the
    // handler's shape-sniff fallback routes them through the claude mapper,
    // whose pagination marker IS the entry uuid.
    const burst = Array.from({ length: total }, (_, i) => ({
      file: 'transcript.jsonl',
      entry: {
        type: 'user',
        uuid: `win-u-${i}`,
        parentUuid: null,
        timestamp: new Date(baseTs + i * 1000).toISOString(),
        message: { role: 'user', content: [{ type: 'text', text: `row ${i}` }] },
      },
    }))

    act(() => {
      fake.emitJsonlEntries({ sessionId, entries: burst })
    })

    const cut = total - TRIM_TO_LIVE_ENTRIES
    const runtime = runtimes[sessionId]
    expect(runtime?.entries.length).toBe(TRIM_TO_LIVE_ENTRIES)
    // The on-disk denominator is untouched by the window.
    expect(runtime?.totalEntries).toBe(total)
    // Pagination can reload the trimmed region: re-anchored strictly at the
    // oldest RETAINED entry, with older history re-enabled.
    expect(runtime?.hasOlderHistory).toBe(true)
    expect(runtime?.historyOldestMarker).toBe(`win-u-${cut}`)
    expect(runtime?.entries[0]?.uuid).toBe(`win-u-${cut}`)
    // Debug bundles stay explainable — the trim leaves a STATE record.
    expect(
      runtime?.feedDebugLog.some(entry => entry.kind === 'entries_trimmed'),
    ).toBe(true)

    // A replay of already-trimmed rows (resume bootstrapTail) must be
    // treated as seen — nothing re-appends at the tail.
    act(() => {
      fake.emitJsonlEntries({ sessionId, entries: burst.slice(0, 5) })
    })
    expect(runtimes[sessionId]?.entries.length).toBe(TRIM_TO_LIVE_ENTRIES)
    expect(runtimes[sessionId]?.totalEntries).toBe(total)
    expect(runtimes[sessionId]?.entries.at(-1)?.uuid).toBe(`win-u-${total - 1}`)
  })
})
