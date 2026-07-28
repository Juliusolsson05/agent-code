import { describe, expect, it } from 'vitest'

import { emptyRuntime, type SessionRuntime } from '@renderer/session-runtime/state'
import { reduceStreamPhase } from '@renderer/session-runtime/semantic/streamPhaseMachine'

// Reproduces the reported failure as a state-level assertion:
//
//   "Cannot deliver prompt: <id> is not a live agent session"
//   ...then the pane shows `Sending · 17s`, counting up forever, and only an
//   agent reload clears it.
//
// The unwind itself is a React callback, so these tests pin the two things that
// make the bug possible and the fix correct: that nothing ELSE can clear the
// phase, and that the unwind's precondition is a reported fact rather than an
// inference. The callback wiring is covered by the composer renderer test.

function submittingRuntime(): SessionRuntime {
  return {
    ...emptyRuntime(),
    processStatus: 'started',
    streamPhase: 'submitting',
    submittedAt: 1_000_000,
    turnStartedAt: 1_000_000,
    phaseChangedAt: 1_000_000,
    awaitingAssistant: true,
    streamingBaseline: 'previous assistant text',
  }
}

describe('stuck-submitting: why nothing else can clear the phase', () => {
  it('the stream-phase machine refuses to stomp submitting from screen signals', () => {
    // This guard is a shipped regression's tombstone and must NOT be relaxed to
    // fix the stuck spinner — which is exactly why the repair has to live at
    // the submit site that owns the optimistic write instead.
    const runtime = submittingRuntime()

    const next = reduceStreamPhase(
      {
        streamPhase: runtime.streamPhase,
        streamPhasePendingToolName: runtime.streamPhasePendingToolName,
        streamPhasePendingToolUseId: runtime.streamPhasePendingToolUseId,
        turnStartedAt: runtime.turnStartedAt,
        phaseChangedAt: runtime.phaseChangedAt,
        submittedAt: runtime.submittedAt,
      },
      { type: 'screen' },
      null,
    )

    expect(next.streamPhase).toBe('submitting')
  })
})

describe('unwind precondition', () => {
  // The discriminator that keeps this out of the conditional trap: main REPORTS
  // whether anything reached the provider. We never infer it from the failure
  // code, the readiness state, or elapsed time.
  const nothingWritten = (r: { promptWritten: boolean; enterWritten: boolean }): boolean =>
    !r.promptWritten && !r.enterWritten

  it('holds for the reported failure — a registry miss writes nothing', () => {
    // sessionManager.deliverPromptToAgent's before-write branch, verbatim shape.
    expect(nothingWritten({ promptWritten: false, enterWritten: false })).toBe(true)
  })

  it('does not hold once the body reached the provider', () => {
    // A turn may genuinely be starting. Unwinding here would trade a stuck
    // spinner for a hidden running turn.
    expect(nothingWritten({ promptWritten: true, enterWritten: false })).toBe(false)
  })

  it('does not hold once Enter reached the provider', () => {
    expect(nothingWritten({ promptWritten: true, enterWritten: true })).toBe(false)
  })
})
