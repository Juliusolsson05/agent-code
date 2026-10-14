import { describe, expect, it } from 'vitest'

import type { HermesRequest } from 'hermes-headless'
import { inboundFrames, latestRecording } from 'hermes-headless/testing/corpus'
import { validateAnswer } from '@providers/hermes/runtime/requestAnswers'

// The trust boundary between a condition card and the wire, on the recorded
// S6 clarify request (q0 single choice, q1 multi, q2 free text). Review b:
// the length guard and the unknown-question refusal were surviving mutants.
const frame = inboundFrames(latestRecording('S6')).find((entry) => entry.method === 'clarify')!
const clarify: HermesRequest = { id: String(frame.id), method: 'clarify', params: frame.params as Record<string, unknown>, replayed: false }

describe('validateAnswer (recorded S6 clarify)', () => {
  it('accepts the answer set Hermes\' own client sent', () => {
    expect(validateAnswer(clarify, { answers: { q0: 'blue', q1: 'a, c', q2: 'nothing else' } }))
      .toEqual({ answers: { q0: 'blue', q1: 'a, c', q2: 'nothing else' } })
  })

  it('refuses an answer to a question Hermes did not ask', () => {
    expect(validateAnswer(clarify, { answers: { q0: 'blue', q9: 'injected' } })).toBeNull()
  })

  it('refuses an oversized free-text answer instead of forwarding it', () => {
    expect(validateAnswer(clarify, { answers: { q2: 'x'.repeat(4001) } })).toBeNull()
  })
})
