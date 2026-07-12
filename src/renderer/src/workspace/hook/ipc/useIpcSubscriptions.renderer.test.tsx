import { describe, expect, it } from 'vitest'
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
