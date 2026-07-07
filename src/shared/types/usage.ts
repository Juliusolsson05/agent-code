import type { AgentProviderKind } from '@shared/types/providerKind.js'

export type UsageProviderKind = Extract<AgentProviderKind, 'claude' | 'codex'>

export type UsageSeverity = 'normal' | 'warning' | 'critical' | 'unknown'

export type UsageLimitRow = {
  id: string
  label: string
  percent: number | null
  severity: UsageSeverity
  resetsAt: string | null
  active: boolean
  detail: string | null
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
