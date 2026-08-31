// deliverWithWake — the composer's recovery for main's "not a live agent
// session" reject (#706).
//
// These tests pin the helper's contract, not the useComposerKeybinds plumbing
// (the hook calls it at its single delivery site). The failure shapes are the
// exact literals `deliverPromptToAgent` produces — in particular the
// never-owned reject recorded in debug bundle 2026-08-30T23-51-06-471-9bd68e14
// — so a change to main's result vocabulary that silently stops matching here
// fails these tests instead of silently disabling the recovery.

import { describe, expect, it } from 'vitest'

import type { PromptDeliveryResult } from '@shared/types/providerConfig'

import { deliverWithWake } from './deliverWithWake'

// Byte-for-byte the sessionManager reject for a missing registry entry
// (sessionManager.ts, the never-owned / entry-lost-after-owned branch).
const NOT_LIVE: PromptDeliveryResult = {
  ok: false,
  stage: 'before-write',
  code: 'not-ready',
  retrySafe: true,
  disposition: 'session-unusable',
  promptWritten: false,
  enterWritten: false,
  message: 'Cannot deliver prompt: s1 is not a live agent session',
}

const DELIVERED: PromptDeliveryResult = {
  ok: true,
  acceptance: { kind: 'user', acceptedAt: 1_000 },
}

function script(results: PromptDeliveryResult[]) {
  const calls: string[] = []
  let attempt = 0
  const deliver = async (): Promise<PromptDeliveryResult> => {
    calls.push('deliver')
    const result = results[attempt]
    attempt += 1
    return result
  }
  return { calls, deliver }
}

describe('deliverWithWake', () => {
  it('wakes and retries once on the not-live reject, in that order', async () => {
    const { calls, deliver } = script([NOT_LIVE, DELIVERED])
    const result = await deliverWithWake(deliver, async () => {
      calls.push('wake')
    })

    // The order IS the fix: the recorded failure was a delivery reaching a
    // dead backend with no wake anywhere in between.
    expect(calls).toEqual(['deliver', 'wake', 'deliver'])
    expect(result).toEqual(DELIVERED)
  })

  it('surfaces the original reject when the wake fails, with no second delivery', async () => {
    const { calls, deliver } = script([NOT_LIVE])
    const result = await deliverWithWake(deliver, async () => {
      calls.push('wake')
      throw new Error('recovery refused')
    })

    // Retrying against a backend that refused to come back reproduces the
    // same failure one attempt later; the wake path already narrated the
    // refusal (pane toast + failed runtime state).
    expect(calls).toEqual(['deliver', 'wake'])
    expect(result).toEqual(NOT_LIVE)
  })

  it('never retries a second not-live reject — one wake is the budget', async () => {
    const { calls, deliver } = script([NOT_LIVE, NOT_LIVE])
    const result = await deliverWithWake(deliver, async () => {
      calls.push('wake')
    })

    expect(calls).toEqual(['deliver', 'wake', 'deliver'])
    expect(result).toEqual(NOT_LIVE)
  })

  it.each<[string, PromptDeliveryResult]>([
    ['a success', DELIVERED],
    // Post-write uncertainty: retrying could duplicate a prompt Claude may
    // already have. disposition/do-not-retry is the existing owner.
    ['an acceptance timeout', {
      ok: false,
      stage: 'after-enter',
      code: 'acceptance-timeout',
      retrySafe: false,
      disposition: 'do-not-retry',
      promptWritten: true,
      enterWritten: true,
      message: 'timed out awaiting acceptance',
    }],
    // A concurrent delivery holds the reservation — the session is healthy,
    // waking it would be noise.
    ['a delivery-in-flight reject', {
      ok: false,
      stage: 'reservation',
      code: 'delivery-in-flight',
      retrySafe: true,
      disposition: 'retry-same-session',
      promptWritten: false,
      enterWritten: false,
      message: 'A prompt delivery is already in flight for session s1',
    }],
  ])('passes %s through with no wake and a single delivery', async (_label, outcome) => {
    const { calls, deliver } = script([outcome])
    const result = await deliverWithWake(deliver, async () => {
      calls.push('wake')
    })

    expect(calls).toEqual(['deliver'])
    expect(result).toEqual(outcome)
  })
})
