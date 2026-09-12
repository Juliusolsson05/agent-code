import type { AgentProviderKind } from '@shared/types/providerKind.js'

export type UsageProviderKind = Extract<AgentProviderKind, 'claude' | 'codex'>

export type UsageSeverity = 'normal' | 'warning' | 'critical' | 'unknown'

/**
 * How much of a provider one limit window covers.
 *
 * WHY this is a normalized field and not something a consumer derives from the
 * label or id: it decides what a user is offered when the window fills. An
 * `all-models` window at 100 percent means nothing on that provider will answer
 * — the remedy is switching provider. A `model-family` window at 100 percent
 * means the account is out of budget for ONE family and another model on the
 * same provider still works — the remedy is switching model, which costs no
 * transcript translation at all (#821, spec §"Exhaustion signal"). Reading that
 * distinction off `"Current week (Fable)"` would make a copy edit change which
 * agents get moved.
 *
 * `unknown` is the honest answer for a shape we have not classified — a new
 * Claude `kind`, or a bare Codex `limits[]` entry — and it is deliberately NOT
 * treated as exhaustion by `deriveProviderExhaustion`.
 */
export type UsageLimitScope = 'all-models' | 'model-family' | 'unknown'

export type UsageLimitRow = {
  id: string
  label: string
  percent: number | null
  severity: UsageSeverity
  resetsAt: string | null
  active: boolean
  detail: string | null
  scope: UsageLimitScope
}

export type UsageSpend = {
  amount: number
  currency: string | null
}

export type UsageProviderOk = {
  provider: UsageProviderKind
  status: 'ok'
  sourceLabel: string
  plan: string | null
  rows: UsageLimitRow[]
  spend: UsageSpend | null
  extraUsage: UsageSpend | null
  credits: UsageSpend | null
}

export type UsageProviderError = {
  provider: UsageProviderKind
  status: 'error'
  sourceLabel: string
  message: string
}

export type UsageProviderSnapshot = UsageProviderOk | UsageProviderError

export type UsageSnapshot = {
  fetchedAt: string
  cache: {
    hit: boolean
    ttlMs: number
  }
  providers: UsageProviderSnapshot[]
}

export type UsageSnapshotRequest = {
  force?: boolean
}
