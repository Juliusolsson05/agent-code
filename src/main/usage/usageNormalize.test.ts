import { describe, expect, it } from 'vitest'

import { normalizeClaudeUsagePayload } from '@main/usage/claudeUsage.js'
import { normalizeCodexUsagePayload } from '@main/usage/codexUsage.js'

// WHY these tests use the real API's field names (kind/group/scope.model)
// rather than a synthetic `name` field:
//
// The first cut of these tests supplied a `name: 'Current week all models'`
// field that the Claude usage endpoint does NOT return. The label function
// happily read it, tests passed, and a real payload rendered as
// "weekly | weekly | session" in the UI because the fall-through hit `group`
// instead. Pinning the tests to the observed shape (`kind`, `group`,
// `scope.model.display_name`) locks the label logic to what the wire actually
// looks like, so a future refactor of `labelClaudeLimit` will only pass tests
// if it still produces human-readable labels from realistic input.

// WHY the two payloads became module constants: the scope tests below assert on
// the SAME observed shapes the label tests do. Copying them would let the two
// halves drift, and a scope test running against a payload the label test does
// not use is a scope test for a shape nobody has seen on the wire.
const REAL_CLAUDE_PAYLOAD = {
  // No top-level `plan` — this simulates the common shape where the wire
  // response omits it and we have to fall back to the Keychain's
  // subscriptionType. If Anthropic starts returning `plan` reliably, the
  // top-level path (see the precedence test below) still wins.
  limits: [
    {
      id: 'session',
      kind: 'session',
      group: 'session',
      percent: 4,
      resets_at: '2027-01-15T09:00:00.000Z',
      is_active: true,
    },
    {
      id: 'weekly-all',
      kind: 'weekly_all',
      group: 'weekly',
      percent: 75,
      resets_at_unix: 1_800_000_000,
      is_active: true,
    },
    {
      id: 'weekly-fable',
      kind: 'weekly_scoped',
      group: 'weekly',
      percent: 42,
      scope: { model: { id: 'fable', display_name: 'Fable' } },
      resets_at_unix: 1_800_000_000,
      is_active: true,
    },
  ],
  spend: { amount: 74, currency: 'USD' },
  extra_usage: { amount: 12, currency: 'USD' },
}

const REAL_CODEX_PAYLOAD = {
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
}

describe('usage normalization', () => {
  it('labels Claude limit windows from kind + scope.model and honors keychain plan fallback', () => {
    const snapshot = normalizeClaudeUsagePayload(
      REAL_CLAUDE_PAYLOAD,
      { fallbackPlan: 'max_20x' },
    )

    expect(snapshot.provider).toBe('claude')
    expect(snapshot.plan).toBe('max_20x')
    // Labels — the important assertion: distinct, human-readable strings that
    // match what the user actually needs to distinguish the three windows.
    // Order is percent DESC (from sortUsageRows), so weekly-all (75) leads,
    // then weekly-fable (42), then session (4).
    expect(snapshot.rows.map(row => row.label)).toEqual([
      'Current week (all models)',
      'Current week (Fable)',
      'Current session',
    ])
    expect(snapshot.rows.map(row => row.percent)).toEqual([75, 42, 4])
    expect(snapshot.rows[0].resetsAt).toBe('2027-01-15T08:00:00.000Z')
    expect(snapshot.spend).toEqual({ amount: 74, currency: 'USD' })
    expect(snapshot.extraUsage).toEqual({ amount: 12, currency: 'USD' })
  })

  it('prefers the API-provided plan over the keychain fallback', () => {
    const snapshot = normalizeClaudeUsagePayload(
      { plan: 'pro', limits: [] },
      { fallbackPlan: 'max_20x' },
    )
    // WHY this pins precedence: if Anthropic ships an authoritative plan value
    // in the response we want it, not our locally-stashed Keychain hint. The
    // fallback is a last resort, not a preferred source.
    expect(snapshot.plan).toBe('pro')
  })

  it('falls back to a legible label when the API adds an unknown `kind` value', () => {
    // WHY: the moment Anthropic adds a new kind (e.g. `monthly_all`) we don't
    // want to regress to raw "weekly" strings; the fallback should still
    // synthesize something distinct from group/scope. This is a canary — if
    // it fails, someone added a kind and needs to extend the switch.
    const snapshot = normalizeClaudeUsagePayload({
      limits: [
        {
          id: 'monthly',
          kind: 'monthly_all',
          group: 'monthly',
          percent: 12,
        },
      ],
    })
    expect(snapshot.rows[0].label).toBe('monthly_all')
  })

  it('normalizes Codex primary and additional rate limits', () => {
    const snapshot = normalizeCodexUsagePayload(REAL_CODEX_PAYLOAD)

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

  // WHY scope is normalized here rather than derived later from the label:
  // "Current week (Fable)" is a rendering decision that can change with the
  // next model name, and `deriveProviderExhaustion` uses scope to decide
  // whether a limit blocks EVERY model on that provider (switch provider) or
  // only one family (switch model). Reading that off a display string would
  // make a UI copy edit silently change which agents get moved.
  it('scopes Claude rows: session and weekly_all are all-models, weekly_scoped is model-family', () => {
    const rows = normalizeClaudeUsagePayload(REAL_CLAUDE_PAYLOAD).rows

    expect(rows.find(row => row.label === 'Current session')?.scope).toBe('all-models')
    expect(rows.find(row => row.label === 'Current week (all models)')?.scope).toBe('all-models')
    expect(rows.find(row => row.label === 'Current week (Fable)')?.scope).toBe('model-family')
  })

  it('scopes Codex rows: the main rate_limit is all-models, additional limits are model-family', () => {
    const rows = normalizeCodexUsagePayload(REAL_CODEX_PAYLOAD).rows

    // The main `rate_limit` object is the account's shared 5h/weekly budget;
    // its ids are prefixed from the "Codex" base label.
    expect(rows.filter(row => row.id.startsWith('codex-')).every(row => row.scope === 'all-models')).toBe(true)
    // Everything under `additional_rate_limits` is per metered feature/model
    // (here GPT-5.3-Codex-Spark), which is exactly the family-scoped case.
    expect(rows.find(row => row.id === 'gpt-5-3-codex-spark-primary-window')?.scope).toBe('model-family')
  })
})
