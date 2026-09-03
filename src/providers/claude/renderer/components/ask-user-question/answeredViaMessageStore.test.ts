import { beforeEach, describe, expect, it } from 'vitest'

import {
  beginAnswer,
  endAnswer,
  isAnswerInFlight,
  useAnswerSubmissionStore,
} from './answeredViaMessageStore'

// #738: the submit latch must be readable synchronously (same-tick double
// click) and by ANY row instance for the operationId (the committed card
// replaces the live row mid-submit).

describe('answer submission latch', () => {
  beforeEach(() => {
    useAnswerSubmissionStore.setState({ inFlight: {} })
  })

  it('is visible synchronously and per question', () => {
    expect(isAnswerInFlight('q1')).toBe(false)
    beginAnswer('q1')
    expect(isAnswerInFlight('q1')).toBe(true)
    expect(isAnswerInFlight('q2')).toBe(false)
    expect(useAnswerSubmissionStore.getState().inFlight).toEqual({ q1: true })
  })

  it('is released on end so the user can retry after a bounded failure', () => {
    beginAnswer('q1')
    endAnswer('q1')
    expect(isAnswerInFlight('q1')).toBe(false)
  })

  it('ending an unknown id leaves the state object untouched', () => {
    const before = useAnswerSubmissionStore.getState()
    endAnswer('never-started')
    expect(useAnswerSubmissionStore.getState()).toBe(before)
  })
})
