import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { act } from 'react'
import { useRef, type MutableRefObject } from 'react'

import { createFakeSessionFeed } from '@renderer/features/sessionFeed/FakeSessionFeed'
import { UndoCloseStack } from '@renderer/lib/undoClose'
import type { SessionRuntime } from '@renderer/session-runtime/state'
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
})
