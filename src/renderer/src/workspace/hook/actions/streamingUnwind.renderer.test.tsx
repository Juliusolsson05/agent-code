import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { emptyRuntime, type SessionRuntime } from '@renderer/session-runtime/state'
import type { SessionId } from '@renderer/workspace/types'

import { useStreamingActions } from './streaming'

// Covers `unwindStreamingBaseline` — the actual repair for the reported bug:
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
    streamingBaseline: 'previous assistant text',
    ...overrides,
  }
}

describe('unwindStreamingBaseline', () => {
  it('clears every field the optimistic submit set, so the spinner stops', () => {
    // WorkIndicator renders 'submitting' as `Sending` and times it from
    // submittedAt. Leaving either behind reproduces the bug.
    const h = harness({ s1: submitting() })

    act(() => {
      h.view.result.current.unwindStreamingBaseline('s1' as SessionId)
    })

    const runtime = h.get('s1' as SessionId)
    expect(runtime.streamPhase).toBe('idle')
    expect(runtime.submittedAt).toBeNull()
    expect(runtime.turnStartedAt).toBeNull()
    expect(runtime.phaseChangedAt).toBeNull()
    expect(runtime.awaitingAssistant).toBe(false)
    expect(runtime.streamingBaseline).toBeNull()
  })

  it('preserves the draft, because a failed submit must not eat the prompt', () => {
    const h = harness({ s1: submitting({ draftInput: 'the prompt I just typed' }) })

    act(() => {
      h.view.result.current.unwindStreamingBaseline('s1' as SessionId)
    })

    expect(h.get('s1' as SessionId).draftInput).toBe('the prompt I just typed')
  })

  it('refuses to unwind a phase this submit did not set', () => {
    // A real provider event can land between the optimistic write and the
    // failure. Stomping it would trade a stuck spinner for a LOST turn — the
    // suppress-before-replace shape the rendering pipeline exists to prevent.
    const running = submitting({ streamPhase: 'responding' })
    const h = harness({ s1: running })

    act(() => {
      h.view.result.current.unwindStreamingBaseline('s1' as SessionId)
    })

    const runtime = h.get('s1' as SessionId)
    expect(runtime.streamPhase).toBe('responding')
    expect(runtime.submittedAt).toBe(1_000_000)
  })

  it('is a no-op for a session that no longer exists', () => {
    // The pane can be closed while a failed delivery is unwinding.
    const h = harness({})

    act(() => {
      h.view.result.current.unwindStreamingBaseline('gone' as SessionId)
    })

    expect(h.all()).toEqual({})
  })

  it('leaves other sessions untouched', () => {
    const h = harness({ s1: submitting(), s2: submitting() })

    act(() => {
      h.view.result.current.unwindStreamingBaseline('s1' as SessionId)
    })

    expect(h.get('s1' as SessionId).streamPhase).toBe('idle')
    expect(h.get('s2' as SessionId).streamPhase).toBe('submitting')
  })
})
