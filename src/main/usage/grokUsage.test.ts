import { describe, expect, it } from 'vitest'

import {
  normalizeGrokUsagePayload,
  jwtExpiryMs,
} from '@main/usage/grokUsage.js'
import { sanitizeUsageError } from '@main/usage/normalize.js'

// Grok reader contracts, from the spec's live-verified capture (2026-09-20):
// camelCase billing envelope, shared-credit primary row, per-product family
// rows, tier as plan. Plus the two bespoke behaviors the spec demands: the
// JWT expiry precheck and its exact user copy surviving error sanitization.

const ENVELOPE = {
  subscriptionTier: 'SuperGrok',
  config: {
    creditUsagePercent: 88,
    currentPeriod: { type: 'monthly', start: 1789800000000, end: 1792392000000 },
    productUsage: [
      { product: 'Grok Build', usagePercent: 90 },
      { product: 'Grok', usagePercent: 71 },
    ],
  },
}

describe('normalizeGrokUsagePayload', () => {
  it('maps the verified billing envelope to tier plan, a shared credit row, and family detail rows', () => {
    const result = normalizeGrokUsagePayload(ENVELOPE)
    expect(result.provider).toBe('grok')
    expect(result.status).toBe('ok')
    expect(result.plan).toBe('SuperGrok')
    expect(result.rows).toHaveLength(3)
    const credits = result.rows.find(row => row.id === 'grok-credits')!
    expect(credits.percent).toBe(88)
    expect(credits.scope).toBe('all-models')
    expect(credits.resetsAt).toBe(new Date(1792392000000).toISOString())
    expect(credits.detail).toBe('monthly')
    const build = result.rows.find(row => row.label === 'Grok Build')!
    expect(build.scope).toBe('model-family')
    expect(build.percent).toBe(90)
    // sortUsageRows orders by percent: 90 (family) before 88 (shared credits).
    expect(result.rows[0]!.label).toBe('Grok Build')
  })

  it('missing config degrades to an empty ok snapshot, never a throw', () => {
    const result = normalizeGrokUsagePayload({ subscriptionTier: 'SuperGrok' })
    expect(result.rows).toEqual([])
    expect(result.plan).toBe('SuperGrok')
  })

  it('ignores product entries without both fields', () => {
    const result = normalizeGrokUsagePayload({
      config: { creditUsagePercent: 10, productUsage: [{ product: 'Ghost' }, { usagePercent: 40 }] },
    })
    expect(result.rows).toHaveLength(1)
  })
})

describe('jwtExpiryMs', () => {
  const jwtWith = (payload: Record<string, unknown>) =>
    `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`

  it('reads expires_at ISO strings (the claim the live capture showed)', () => {
    expect(jwtExpiryMs(jwtWith({ expires_at: '2026-09-20T12:18:39Z' }))).toBe(Date.parse('2026-09-20T12:18:39Z'))
  })

  it('falls back to epoch-seconds exp and rejects garbage without throwing', () => {
    expect(jwtExpiryMs(jwtWith({ exp: 1790000000 }))).toBe(1790000000 * 1000)
    expect(jwtExpiryMs('not-a-jwt')).toBeNull()
    expect(jwtExpiryMs(jwtWith({ expires_at: 'nope' }))).toBeNull()
  })
})

describe('error surface', () => {
  it('the login-expired copy survives sanitization verbatim', () => {
    // The generic sanitizer replaces unknown messages with a fallback; the
    // expiry row is only useful if its self-heal instructions reach the user.
    expect(sanitizeUsageError(new Error('Grok login expired — start any Grok session to refresh it.'), 'fallback'))
      .toBe('Grok login expired — start any Grok session to refresh it.')
  })
})
