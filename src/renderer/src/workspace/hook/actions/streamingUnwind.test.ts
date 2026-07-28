import { describe, expect, it } from 'vitest'

import { emptyRuntime, type SessionRuntime } from '@renderer/session-runtime/state'
import { reduceStreamPhase } from '@renderer/session-runtime/semantic/streamPhaseMachine'

// Reproduces the reported failure as a state-level assertion:
//
//   "Cannot deliver prompt: <id> is not a live agent session"
//   ...then the pane shows `Sending · 17s`, counting up forever, and only an
//   agent reload clears it.
//
// This file pins ONE thing: that nothing else in the system can clear the
// stuck phase, which is why the repair has to live at the submit site.
//
// The unwind itself is covered by streamingUnwind.renderer.test.tsx, which
// drives the real hook. An earlier version of this file also "tested" a
// predicate defined in the test file itself — it imported nothing from
// production and could not fail if the fix regressed. Deleted rather than kept
// for the count.

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
