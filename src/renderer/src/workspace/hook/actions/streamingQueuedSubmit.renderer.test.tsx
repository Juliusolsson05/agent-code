import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SemanticLiveTurn, SessionRuntime } from '@renderer/session-runtime/state'
import { reduceStreamPhase } from '@renderer/session-runtime/semantic/streamPhaseMachine'
import { hasPendingSemanticTools } from '@renderer/session-runtime/semantic/helpers'
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
const S2 = 's2' as SessionId

afterEach(() => {
  vi.restoreAllMocks()
})

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

    let stamp: number | null = null
    act(() => { stamp = h.view.result.current.beginOptimisticSubmit(S1) })

    const runtime = h.get(S1)
    expect(runtime.streamPhase).toBe('submitting')
    expect(runtime.submittedAt).not.toBeNull()
    // The returned token IS the stamp written, the only thing the queue settle
    // may later match against.
    expect(stamp).toBe(runtime.submittedAt)
    expect(runtime.turnStartedAt).toBe(runtime.submittedAt)
    expect(runtime.awaitingAssistant).toBe(true)
    expect(runtime.pendingRewindUndo).toBeNull()
  })

  it('issues distinct stamps even within one millisecond', () => {
    // The stamp is an ownership token. Two stamps that compare equal would let a
    // settle revert a claim it did not write, so uniqueness is the invariant,
    // not a clock nicety.
    vi.spyOn(Date, 'now').mockReturnValue(5_000)
    const h = harness({ [S1]: idlePane(), [S2]: idlePane() })

    let first: number | null = null
    let second: number | null = null
    act(() => {
      first = h.view.result.current.beginOptimisticSubmit(S1)
      second = h.view.result.current.beginOptimisticSubmit(S2)
    })

    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(second).not.toBe(first)
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

    let stamp: number | null = -1
    act(() => { stamp = h.view.result.current.beginOptimisticSubmit(S1) })

    const runtime = h.get(S1)
    // No stamp written, so no token: this submit owns no phase claim to settle.
    expect(stamp).toBeNull()
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

  it('does not stamp Sending while a tool is still running under an ended turn', () => {
    // #893 review F2, the half that must NOT change. For a whole Claude Bash or
    // Task run (and a Codex function_call), the adapter has already closed the
    // proxy turn at the response boundary and published `awaiting-tool`. The fold
    // keeps that ended turn mounted because its tool is pending.
    // `isSemanticTurnRunning` is false here, which is exactly why "awaiting-tool
    // with no running turn" alone cannot mean idle: Claude queues this submit.
    const toolRun: SemanticLiveTurn = {
      ...liveTurn(),
      stopReason: 'tool_use',
      endedAt: 950_000,
      blocks: {
        0: { kind: 'tool_use', toolUseId: 'toolu_bash', toolName: 'Bash', resultAt: null } as never,
      },
    }
    expect(hasPendingSemanticTools(toolRun)).toBe(true)
    const h = harness({
      [S1]: idlePane({
        streamPhase: 'awaiting-tool',
        streamPhasePendingToolName: 'Bash',
        streamPhasePendingToolUseId: 'toolu_bash',
        turnStartedAt: 900_000,
        phaseChangedAt: 950_000,
        semantic: { ...emptyRuntime().semantic, currentTurn: toolRun },
      }),
    })

    let stamp: number | null = -1
    act(() => { stamp = h.view.result.current.beginOptimisticSubmit(S1) })

    const runtime = h.get(S1)
    expect(stamp).toBeNull()
    expect(runtime.streamPhase).toBe('awaiting-tool')
    expect(runtime.turnStartedAt).toBe(900_000)
  })

  it('stamps Sending on an awaiting-tool phase that outlived its tool', () => {
    // #893 review F2, the documented Codex shape. A tool resolved through
    // `tool_completed` archives the ended turn, but the phase machine leaves
    // `awaiting-tool` only on a matching `tool_result`, so the phase is left over
    // with no running turn and nothing pending. A submit here can START a turn,
    // so the pre-#889 stamp is truthful and must still happen.
    const h = harness({
      [S1]: idlePane({
        streamPhase: 'awaiting-tool',
        streamPhasePendingToolName: 'mcp__docs__search',
        streamPhasePendingToolUseId: 'call_docs',
        turnStartedAt: 900_000,
        phaseChangedAt: 950_000,
      }),
    })

    let stamp: number | null = null
    act(() => { stamp = h.view.result.current.beginOptimisticSubmit(S1) })

    const runtime = h.get(S1)
    expect(stamp).not.toBeNull()
    expect(runtime.streamPhase).toBe('submitting')
    expect(runtime.submittedAt).toBe(stamp)
    expect(runtime.turnStartedAt).toBe(stamp)
    expect(runtime.awaitingAssistant).toBe(true)
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

    act(() => h.view.result.current.settleQueuedSubmit(S1, 1_000_000))

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

    act(() => h.view.result.current.settleQueuedSubmit(S1, 1_000_000))

    const runtime = h.get(S1)
    expect(runtime.awaitingAssistant).toBe(true)
    expect(runtime.queuedMessages).toBe(queued)
  })

  it('refuses to touch a phase a real event already moved', () => {
    // If a real event moved the phase between the stamp and the acceptance,
    // that phase is the truth. Same rule as unwindOptimisticSubmit.
    const h = harness({ [S1]: stamped({ streamPhase: 'responding' }) })
    const before = h.get(S1)

    act(() => h.view.result.current.settleQueuedSubmit(S1, 1_000_000))

    expect(h.get(S1)).toBe(before)
  })

  it('never settles the Sending an earlier submit still owns', () => {
    // Codex review (major) / Claude F1, the recorded sequence:
    //   A on an idle pane stamps `submitting` and main answers `user`, so the
    //   composer releases its in-flight guard before A's first provider event.
    //   B arrives in that gap, skips its stamp (the pane is not idle), and
    //   Claude queues it.
    // B's queue settle carries B's null token. A's claim, and A's clock, must
    // survive until A's own provider evidence supersedes them.
    const h = harness({ [S1]: idlePane() })
    let stampA: number | null = null
    let stampB: number | null = -1
    act(() => { stampA = h.view.result.current.beginOptimisticSubmit(S1) })
    act(() => { stampB = h.view.result.current.beginOptimisticSubmit(S1) })
    expect(stampA).not.toBeNull()
    expect(stampB).toBeNull()

    act(() => h.view.result.current.settleQueuedSubmit(S1, stampB))

    const afterB = h.get(S1)
    expect(afterB.streamPhase).toBe('submitting')
    expect(afterB.submittedAt).toBe(stampA)
    expect(afterB.turnStartedAt).toBe(stampA)

    // A's first real event still finds A's claim to advance. Had the settle
    // idled it, this bridge would be a no-op: it only leaves
    // `submitting`/`requesting`.
    const advanced = reduceStreamPhase(afterB, { type: 'turn_started', turnId: 'msg_a' }, null)
    expect(advanced.streamPhase).toBe('responding')
    expect(advanced.turnStartedAt).toBe(stampA)
  })

  it('never settles a stamp a later submit wrote over its own', () => {
    // The token must match exactly, not merely be non-null: a stale token from a
    // retired claim must not revert the claim that replaced it.
    const h = harness({ [S1]: stamped({ submittedAt: 2_000_000, turnStartedAt: 2_000_000 }) })
    const before = h.get(S1)

    act(() => h.view.result.current.settleQueuedSubmit(S1, 1_000_000))

    expect(h.get(S1)).toBe(before)
  })

  it('is a no-op for a session that no longer exists', () => {
    const h = harness({})

    act(() => h.view.result.current.settleQueuedSubmit('gone' as SessionId, 1_000_000))

    expect(h.all()).toEqual({})
  })
})
