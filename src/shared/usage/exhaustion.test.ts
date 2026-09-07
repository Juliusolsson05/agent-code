import { describe, expect, it } from 'vitest'
import type { UsageLimitRow } from '@shared/types/usage.js'

import { deriveProviderExhaustion } from './exhaustion.js'

const row = (overrides: Partial<UsageLimitRow>): UsageLimitRow => ({
  id: 'x',
  label: 'x',
  percent: 0,
  severity: 'normal',
  resetsAt: null,
  active: true,
  detail: null,
  scope: 'all-models',
  ...overrides,
})

const ok = (rows: UsageLimitRow[]) => ({
  provider: 'claude' as const,
  status: 'ok' as const,
  sourceLabel: 's',
  plan: null,
  rows,
  spend: null,
  extraUsage: null,
  credits: null,
})

describe('deriveProviderExhaustion', () => {
  it('is exhausted with all-models scope when a shared window is at 100', () => {
    expect(deriveProviderExhaustion(ok([
      row({ label: 'Current session', percent: 100, resetsAt: '2026-09-05T16:00:00Z' }),
    ]))).toEqual({
      provider: 'claude',
      exhausted: true,
      scope: 'all-models',
      resetsAt: '2026-09-05T16:00:00Z',
      label: 'Current session',
    })
  })

  it('is exhausted with model-family scope when only a scoped weekly row is at 100', () => {
    // The distinction the modal spends: an all-models window means the whole
    // provider is unusable and the answer is a provider switch; a family window
    // means another model on the SAME provider is still available, so the modal
    // offers "switch model instead". Reporting the wrong scope moves agents
    // that did not need moving.
    const result = deriveProviderExhaustion(ok([
      row({ label: 'Current week (Fable)', percent: 100, scope: 'model-family' }),
      row({ label: 'Current session', percent: 40 }),
    ]))

    expect(result.exhausted).toBe(true)
    expect(result.scope).toBe('model-family')
    expect(result.label).toBe('Current week (Fable)')
  })

  it('prefers the all-models window when both scopes are exhausted', () => {
    // Both are true at once whenever a family window fills the account's shared
    // budget. The shared one is the stronger statement — no model on this
    // provider will answer — so it must win, or the modal would offer a model
    // switch that cannot work.
    const result = deriveProviderExhaustion(ok([
      row({ label: 'Current week (Fable)', percent: 100, scope: 'model-family' }),
      row({ label: 'Current session', percent: 100 }),
    ]))

    expect(result.scope).toBe('all-models')
    expect(result.label).toBe('Current session')
  })

  it('ignores inactive rows so a window the provider does not enforce cannot block a switch', () => {
    expect(deriveProviderExhaustion(ok([
      row({ label: 'Disabled window', percent: 100, active: false }),
    ])).exhausted).toBe(false)
  })

  it('is not exhausted below 100 and unknown on error snapshots', () => {
    // 99.4 is deliberately just under: `severityFromPercent` already calls 95
    // "critical" for the header's color, but a window at 99 still accepts
    // turns. Only a window the provider reports as fully used is exhaustion.
    expect(deriveProviderExhaustion(ok([row({ percent: 99.4 })])).exhausted).toBe(false)
    expect(deriveProviderExhaustion({
      provider: 'codex',
      status: 'error',
      sourceLabel: 's',
      message: 'boom',
    })).toMatchObject({ exhausted: false, scope: 'unknown' })
  })
})
