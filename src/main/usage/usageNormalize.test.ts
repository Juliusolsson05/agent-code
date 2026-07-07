import { describe, expect, it } from 'vitest'

import { normalizeClaudeUsagePayload } from '@main/usage/claudeUsage.js'
import { normalizeCodexUsagePayload } from '@main/usage/codexUsage.js'

describe('usage normalization', () => {
  it('normalizes Claude limit windows and spend fields', () => {
    const snapshot = normalizeClaudeUsagePayload({
      plan: 'max',
      limits: [
        {
          id: 'weekly',
          name: 'Current week all models',
          percent: 75,
          resets_at_unix: 1_800_000_000,
        },
        {
          id: 'session',
          name: 'Current session',
          percent: 4,
        },
      ],
      spend: { amount: 74, currency: 'USD' },
      extra_usage: { amount: 12, currency: 'USD' },
    })

    expect(snapshot.provider).toBe('claude')
    expect(snapshot.plan).toBe('max')
    expect(snapshot.rows.map(row => [row.id, row.percent])).toEqual([
      ['weekly', 75],
      ['session', 4],
    ])
    expect(snapshot.rows[0].resetsAt).toBe('2027-01-15T08:00:00.000Z')
    expect(snapshot.spend).toEqual({ amount: 74, currency: 'USD' })
    expect(snapshot.extraUsage).toEqual({ amount: 12, currency: 'USD' })
  })

  it('normalizes Codex primary and additional rate limits', () => {
    const snapshot = normalizeCodexUsagePayload({
      plan_type: 'pro',
      rate_limit: {
        allowed: true,
        primary_window: {
          used_percent: 12,
          limit_window_seconds: 18_000,
          reset_at: 1_800_000_000,
        },
        secondary_window: {
          used_percent: 2,
          limit_window_seconds: 604_800,
        },
      },
      additional_rate_limits: [
        {
          id: 'weekly',
          limit_name: 'GPT-5.3-Codex-Spark',
          rate_limit: {
            allowed: true,
            primary_window: {
              used_percent: 0,
              limit_window_seconds: 18_000,
            },
          },
        },
      ],
    })

    expect(snapshot.provider).toBe('codex')
    expect(snapshot.plan).toBe('pro')
    expect(snapshot.rows.map(row => [row.id, row.label, row.percent])).toEqual([
      ['codex-primary-window', 'Codex 5h', 12],
      ['codex-secondary-window', 'Codex weekly', 2],
      ['gpt-5-3-codex-spark-primary-window', 'GPT-5.3-Codex-Spark 5h', 0],
    ])
    expect(snapshot.rows[0].resetsAt).toBe('2027-01-15T08:00:00.000Z')
    expect(snapshot.rows[1].detail).toBe('weekly window')
  })
})
