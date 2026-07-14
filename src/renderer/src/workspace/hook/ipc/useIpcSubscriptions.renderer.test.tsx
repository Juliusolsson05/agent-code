import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { act } from 'react'
import { useRef } from 'react'
import type { MutableRefObject } from 'react'

import { createFakeSessionFeed } from '@renderer/features/sessionFeed/FakeSessionFeed'
import { UndoCloseStack } from '@renderer/lib/undoClose'
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
