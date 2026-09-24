import { describe, expect, it } from 'vitest'

import { normalizeZaiUsagePayload } from '@main/usage/zaiUsage.js'

// z.ai reader contracts, from the spec's live-verified capture (2026-09-20):
// unit-keyed window classification (NEVER positional), both windows all-models,
// epoch-ms resets, plan = data.level — plus the three failure shapes that must
// throw rather than render as empty quota.

const ENVELOPE = {
  code: 200,
  msg: 'Operation successful',
  success: true,
  data: {
    level: 'max',
    limits: [
      { type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 28000, currentValue: 118, remaining: 27881, percentage: 1, nextResetTime: 1789962887570 },
      { type: 'CREDIT_LIMIT', unit: 6, number: 1, usage: 140000, currentValue: 92781, remaining: 47218, percentage: 66, nextResetTime: 1790028489981 },
    ],
  },
}

describe('normalizeZaiUsagePayload', () => {
  it('maps the verified envelope: two all-models windows keyed by unit, level as plan', () => {
    const result = normalizeZaiUsagePayload(ENVELOPE)
    expect(result.status).toBe('ok')
    expect(result.plan).toBe('max')
    expect(result.rows).toHaveLength(2)
    const fiveHour = result.rows.find(row => row.id === 'zai-5h')!
    expect(fiveHour.label).toBe('5-hour window')
    expect(fiveHour.percent).toBe(1)
    expect(fiveHour.scope).toBe('all-models')
    expect(fiveHour.resetsAt).toBe(new Date(1789962887570).toISOString())
    const week = result.rows.find(row => row.id === 'zai-7d')!
    expect(week.percent).toBe(66)
    // Sorted by percent: 66 before 1.
    expect(result.rows[0]!.id).toBe('zai-7d')
  })

  it('classifies by unit, not position — a reordered envelope keeps labels true', () => {
    const reordered = { ...ENVELOPE, data: { ...ENVELOPE.data, limits: [...ENVELOPE.data.limits].reverse() } }
    const result = normalizeZaiUsagePayload(reordered)
    expect(result.rows.find(row => row.id === 'zai-5h')!.percent).toBe(1)
    expect(result.rows.find(row => row.id === 'zai-7d')!.percent).toBe(66)
  })

  it('HTTP-200 inner failures throw instead of rendering empty quota', () => {
    expect(() => normalizeZaiUsagePayload({ code: 500, msg: '404 NOT_FOUND', success: false }))
      .toThrow(/reported a failure: 404 NOT_FOUND/)
    expect(() => normalizeZaiUsagePayload({ code: 200, success: true, data: {} }))
      .toThrow(/no limits/)
  })

  it('an unclassifiable unit is drift: error, never a guess', () => {
    const drifted = { code: 200, success: true, data: { level: 'max', limits: [{ ...ENVELOPE.data.limits[0]!, unit: 9 }] } }
    expect(() => normalizeZaiUsagePayload(drifted)).toThrow(/unrecognized window \(unit 9\)/)
  })

  it('TIME_LIMIT entries without a percentage are skipped, not fatal', () => {
    const withTime = { ...ENVELOPE, data: { ...ENVELOPE.data, limits: [...ENVELOPE.data.limits, { type: 'TIME_LIMIT', unit: 42, nextResetTime: 1790000000000 }] } }
    const result = normalizeZaiUsagePayload(withTime)
    expect(result.rows).toHaveLength(2)
  })
})
