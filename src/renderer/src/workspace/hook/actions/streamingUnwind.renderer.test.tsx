import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { emptyRuntime, type SessionRuntime } from '@renderer/session-runtime/state'
import { reduceStreamPhase } from '@renderer/session-runtime/semantic/streamPhaseMachine'
import type { SessionId } from '@renderer/workspace/types'

import { useStreamingActions } from './streaming'

// Covers `unwindOptimisticSubmit` — the actual repair for the reported bug:
//
//   "Cannot deliver prompt: <id> is not a live agent session", then the pane
//   shows `Sending · 17s` counting up forever until the agent is reloaded.
//
// An earlier version of this suite asserted a predicate defined inside the test
// file (`!promptWritten && !enterWritten`), which imported nothing from
// production and could not fail if the fix regressed. These tests drive the
// real hook against real runtime state instead.

function harness(initial: Record<SessionId, SessionRuntime>) {
  let runtimes = initial
  const view = renderHook(() =>
    useStreamingActions(updater => {
      runtimes = typeof updater === 'function' ? updater(runtimes) : updater
    }, () => true),
  )
  return { view, get: (id: SessionId) => runtimes[id], all: () => runtimes }
}

function submitting(overrides: Partial<SessionRuntime> = {}): SessionRuntime {
  return {
    ...emptyRuntime(),
    processStatus: 'started',
    streamPhase: 'submitting',
    submittedAt: 1_000_000,
    turnStartedAt: 1_000_000,
    phaseChangedAt: 1_000_000,
    awaitingAssistant: true,
    ...overrides,
  }
}

describe('unwindOptimisticSubmit', () => {
  it('clears every field the optimistic submit set, so the spinner stops', () => {
    // WorkIndicator renders 'submitting' as `Sending` and times it from
    // submittedAt. Leaving either behind reproduces the bug.
    const h = harness({ s1: submitting() })

    act(() => {
      h.view.result.current.unwindOptimisticSubmit('s1' as SessionId, 1_000_000)
    })

    const runtime = h.get('s1' as SessionId)
    expect(runtime.streamPhase).toBe('idle')
    expect(runtime.submittedAt).toBeNull()
    expect(runtime.turnStartedAt).toBeNull()
    expect(runtime.phaseChangedAt).toBeNull()
    expect(runtime.awaitingAssistant).toBe(false)
  })

  it('preserves the draft, because a failed submit must not eat the prompt', () => {
    const h = harness({ s1: submitting({ draftInput: 'the prompt I just typed' }) })

    act(() => {
      h.view.result.current.unwindOptimisticSubmit('s1' as SessionId, 1_000_000)
    })

    expect(h.get('s1' as SessionId).draftInput).toBe('the prompt I just typed')
  })

  it('refuses to unwind a phase a real event already moved', () => {
    // A real provider event can land between the optimistic write and the
    // failure. Stomping it would trade a stuck spinner for a LOST turn — the
    // suppress-before-replace shape the rendering pipeline exists to prevent.
    const running = submitting({ streamPhase: 'responding' })
    const h = harness({ s1: running })

    act(() => {
      h.view.result.current.unwindOptimisticSubmit('s1' as SessionId, 1_000_000)
    })

    const runtime = h.get('s1' as SessionId)
    expect(runtime.streamPhase).toBe('responding')
    expect(runtime.submittedAt).toBe(1_000_000)
  })

  it('is a no-op for a session that no longer exists', () => {
    // The pane can be closed while a failed delivery is unwinding.
    const h = harness({})

    act(() => {
      h.view.result.current.unwindOptimisticSubmit('gone' as SessionId, 1_000_000)
    })

    expect(h.all()).toEqual({})
  })

  it('leaves other sessions untouched', () => {
    const h = harness({ s1: submitting(), s2: submitting() })

    act(() => {
      h.view.result.current.unwindOptimisticSubmit('s1' as SessionId, 1_000_000)
    })

    expect(h.get('s1' as SessionId).streamPhase).toBe('idle')
    expect(h.get('s2' as SessionId).streamPhase).toBe('submitting')
  })

  it('never unwinds the Sending an earlier submit still owns', () => {
    // #893 review round 2 (R2-1), the unwind twin of the queue settle's
    // ownership test in streamingQueuedSubmit.renderer.test.tsx:
    //   A on an idle pane stamps `submitting` and main answers `user`, so the
    //   composer releases its in-flight guard before A's first provider event.
    //   B arrives in that gap, skips its stamp (the pane is not idle), and its
    //   delivery fails with nothing written.
    // B's unwind carries B's null token. A's turn is genuinely starting, so its
    // claim, both clocks and `awaitingAssistant` must survive B's failure.
    const h = harness({ s1: { ...emptyRuntime(), processStatus: 'started' } })
    let stampA: number | null = null
    let stampB: number | null = -1
    act(() => { stampA = h.view.result.current.beginOptimisticSubmit('s1' as SessionId) })
    act(() => { stampB = h.view.result.current.beginOptimisticSubmit('s1' as SessionId) })
    expect(stampA).not.toBeNull()
    expect(stampB).toBeNull()

    act(() => {
      h.view.result.current.unwindOptimisticSubmit('s1' as SessionId, stampB)
    })

    const afterB = h.get('s1' as SessionId)
    expect(afterB.streamPhase).toBe('submitting')
    expect(afterB.submittedAt).toBe(stampA)
    expect(afterB.turnStartedAt).toBe(stampA)
    expect(afterB.phaseChangedAt).toBe(stampA)
    expect(afterB.awaitingAssistant).toBe(true)

    // A's first real event still finds A's claim to advance. Had the unwind
    // idled it, this bridge would be a no-op: it only leaves
    // `submitting`/`requesting`.
    const advanced = reduceStreamPhase(afterB, { type: 'turn_started', turnId: 'msg_a' }, null)
    expect(advanced.streamPhase).toBe('responding')
    expect(advanced.turnStartedAt).toBe(stampA)
  })

  it('never unwinds a claim a later submit wrote over its own', () => {
    // The token must match exactly, not merely be non-null: a retired stamp
    // must not unwind the claim that replaced it.
    const h = harness({ s1: submitting({ submittedAt: 2_000_000, turnStartedAt: 2_000_000 }) })
    const before = h.get('s1' as SessionId)

    act(() => {
      h.view.result.current.unwindOptimisticSubmit('s1' as SessionId, 1_000_000)
    })

    expect(h.get('s1' as SessionId)).toBe(before)
  })
})
