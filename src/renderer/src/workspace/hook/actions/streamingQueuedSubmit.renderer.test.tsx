import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SemanticLiveTurn, SessionRuntime } from '@renderer/session-runtime/state'
import type { SessionId } from '@renderer/workspace/types'

import { useStreamingActions } from './streaming'

// #889 — the optimistic `submitting` phase versus a prompt Claude QUEUES.
//
// `beginOptimisticSubmit` used to stamp `streamPhase: 'submitting'` on every
// submit. When the pane already had a live turn, Claude accepted the prompt
// into its queue, no `turn_started` bridge ever fired for it, and the
// stream-phase machine (correctly) refuses to stomp `submitting` from screen
// signals — so the WorkIndicator painted `Sending · Ns` over a turn that was
// busy thinking, for as long as that turn emitted no `stream_phase` event
// (21 s and 46 s in the 2026-09-11 recordings).
//
// Two contracts, one per repair:
//   1. Over a live turn the optimistic stamp is not applied at all.
//   2. `settleQueuedSubmit` reverts a stamped `submitting` — and only that —
//      once main reports the acceptance kind `queue`.

function harness(initial: Record<SessionId, SessionRuntime>) {
  let runtimes = initial
  const view = renderHook(() =>
    useStreamingActions(updater => {
      runtimes = typeof updater === 'function' ? updater(runtimes) : updater
    }, () => false),
  )
  return { view, get: (id: SessionId) => runtimes[id], all: () => runtimes }
}

const S1 = 's1' as SessionId

function liveTurn(): SemanticLiveTurn {
  return {
    turnId: 'msg_live',
    text: '',
    source: 'proxy',
    blocks: {},
    blockOrder: [],
    stopReason: null,
    usage: null,
    task: {
      todos: [],
      doneCount: 0,
      totalCount: 0,
      inProgressToolUseIds: [],
      activeToolNames: [],
    },
    startedAt: 900_000,
    endedAt: null,
    lookups: {
      toolCallsById: {},
      toolUseIdsInOrder: [],
      resolvedToolUseIds: [],
      erroredToolUseIds: [],
    },
  } as SemanticLiveTurn
}

function idlePane(overrides: Partial<SessionRuntime> = {}): SessionRuntime {
  return { ...emptyRuntime(), processStatus: 'started', ...overrides }
}

describe('beginOptimisticSubmit', () => {
  it('stamps the optimistic phase on an idle pane (the pre-existing contract)', () => {
    const h = harness({ [S1]: idlePane({ pendingRewindUndo: { kind: 'x' } as never }) })

    act(() => h.view.result.current.beginOptimisticSubmit(S1))

    const runtime = h.get(S1)
    expect(runtime.streamPhase).toBe('submitting')
    expect(runtime.submittedAt).not.toBeNull()
    expect(runtime.turnStartedAt).toBe(runtime.submittedAt)
    expect(runtime.awaitingAssistant).toBe(true)
    expect(runtime.pendingRewindUndo).toBeNull()
  })

  it('does not stamp Sending over a live turn signalled by the stream phase', () => {
    // The 10:02:38 recording: streamPhase was the running turn's phase when the
    // user pressed Enter. Painting `submitting` here is the lie at its source.
    const h = harness({
      [S1]: idlePane({
        streamPhase: 'thinking',
        turnStartedAt: 1_000_000,
        phaseChangedAt: 1_000_500,
        submittedAt: null,
        pendingRewindUndo: { kind: 'x' } as never,
      }),
    })

    act(() => h.view.result.current.beginOptimisticSubmit(S1))

    const runtime = h.get(S1)
    expect(runtime.streamPhase).toBe('thinking')
    expect(runtime.turnStartedAt).toBe(1_000_000)
    expect(runtime.phaseChangedAt).toBe(1_000_500)
    expect(runtime.submittedAt).toBeNull()
    // Everything that is NOT a phase claim still happens: continuing from a
    // rewound branch still retires Undo Rewind, queued or not.
    expect(runtime.pendingRewindUndo).toBeNull()
  })

  it('does not stamp Sending over a live turn signalled by the semantic turn alone', () => {
    // A turn can be running with the phase machine still at idle (first
    // deltas before the first stream_phase, or a provider that emits none).
    // The semantic turn is the other live signal and must gate the same way.
    const h = harness({
      [S1]: idlePane({
        semantic: { ...emptyRuntime().semantic, currentTurn: liveTurn() },
      }),
    })

    act(() => h.view.result.current.beginOptimisticSubmit(S1))

    const runtime = h.get(S1)
    expect(runtime.streamPhase).toBe('idle')
    expect(runtime.submittedAt).toBeNull()
    expect(runtime.turnStartedAt).toBeNull()
  })
})

describe('settleQueuedSubmit', () => {
  function stamped(overrides: Partial<SessionRuntime> = {}): SessionRuntime {
    return idlePane({
      streamPhase: 'submitting',
      submittedAt: 1_000_000,
      turnStartedAt: 1_000_000,
      phaseChangedAt: 1_000_000,
      awaitingAssistant: true,
      ...overrides,
    })
  }

  it('reverts a stamped Sending to idle when the acceptance was a queue', () => {
    const h = harness({ [S1]: stamped() })

    act(() => h.view.result.current.settleQueuedSubmit(S1))

    const runtime = h.get(S1)
    expect(runtime.streamPhase).toBe('idle')
    expect(runtime.submittedAt).toBeNull()
    expect(runtime.turnStartedAt).toBeNull()
    expect(runtime.phaseChangedAt).toBeNull()
    expect(runtime.streamPhasePendingToolName).toBeNull()
    expect(runtime.streamPhasePendingToolUseId).toBeNull()
  })

  it('leaves the queue-owned fields alone: awaitingAssistant and queuedMessages', () => {
    // The queue-operation reducer owns both, and its enqueue burst can land
    // before OR after the acceptance. Touching them here would race it.
    const queued = [{ content: 'queued prompt', timestamp: 't' }]
    const h = harness({ [S1]: stamped({ queuedMessages: queued }) })

    act(() => h.view.result.current.settleQueuedSubmit(S1))

    const runtime = h.get(S1)
    expect(runtime.awaitingAssistant).toBe(true)
    expect(runtime.queuedMessages).toBe(queued)
  })

  it('refuses to touch a phase this submit did not stamp', () => {
    // If a real event moved the phase between the stamp and the acceptance,
    // that phase is the truth. Same rule as unwindOptimisticSubmit.
    const h = harness({ [S1]: stamped({ streamPhase: 'responding' }) })
    const before = h.get(S1)

    act(() => h.view.result.current.settleQueuedSubmit(S1))

    expect(h.get(S1)).toBe(before)
  })

  it('is a no-op for a session that no longer exists', () => {
    const h = harness({})

    act(() => h.view.result.current.settleQueuedSubmit('gone' as SessionId))

    expect(h.all()).toEqual({})
  })
})
