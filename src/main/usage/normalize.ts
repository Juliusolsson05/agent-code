import type {
  UsageLimitRow,
  UsageProviderOk,
  UsageSeverity,
  UsageSpend,
} from '@shared/types/usage.js'

export function percentFromRatio(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  if (value <= 1) return Math.max(0, Math.min(100, Math.round(value * 100)))
  return Math.max(0, Math.min(100, Math.round(value)))
}

export function severityFromPercent(percent: number | null): UsageSeverity {
  if (percent === null) return 'unknown'
  if (percent >= 95) return 'critical'
  if (percent >= 75) return 'warning'
  return 'normal'
}

export function isoFromUnixSeconds(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  return new Date(value * 1000).toISOString()
}

export function isoFromSecondsFromNow(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  return new Date(Date.now() + value * 1000).toISOString()
}

export function stringOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

export function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function spendFromObject(value: unknown): UsageSpend | null {
  const obj = readObject(value)
  const amount = numberOrNull(obj.amount)
    ?? numberOrNull(obj.value)
    ?? numberOrNull(obj.usage)
    ?? numberOrNull(Number.parseFloat(String(obj.balance ?? '')))
  if (amount === null) return null
  return {
    amount,
    currency: stringOrNull(obj.currency) ?? stringOrNull(obj.unit),
  }
}

export function makeUsageRow(args: {
  id: string
  label: string
  percent: number | null
  resetsAt?: string | null
  active?: boolean
  detail?: string | null
}): UsageLimitRow {
  return {
    id: args.id,
    label: args.label,
    percent: args.percent,
    severity: severityFromPercent(args.percent),
    resetsAt: args.resetsAt ?? null,
    active: args.active ?? true,
    detail: args.detail ?? null,
  }
}

export function sortUsageRows(rows: UsageLimitRow[]): UsageLimitRow[] {
  return [...rows].sort((a, b) => {
    const aPercent = a.percent ?? -1
    const bPercent = b.percent ?? -1
    if (bPercent !== aPercent) return bPercent - aPercent
    return a.label.localeCompare(b.label)
  })
}

export function sanitizeUsageError(err: unknown, fallback: string): string {
  if (!(err instanceof Error)) return fallback
  const message = err.message.trim()
  if (!message) return fallback
  // WHY this deliberately throws away most low-level detail:
  //
  // Provider usage calls are authenticated with bearer tokens pulled from
  // Claude/Codex's own auth stores. Even though fetch and Keychain errors
  // normally do not include the token, rendering raw exception text in the
  // app would make every future dependency upgrade a secret-leak audit. Keep
  // enough status for the user to act on, but never surface request headers,
  // raw bodies, or filesystem contents.
  if (message.includes('401') || message.includes('403')) return 'Provider rejected the current auth token.'
  if (message.includes('404')) return 'Provider usage endpoint was not found.'
  if (message.includes('429')) return 'Provider usage endpoint rate limited the request.'
  if (message.includes('Keychain')) return message
  if (message.includes('auth.json')) return message
  return fallback
}

export function emptyProviderOk(provider: UsageProviderOk['provider'], sourceLabel: string): UsageProviderOk {
  return {
    provider,
    status: 'ok',
    sourceLabel,
    plan: null,
    rows: [],
    spend: null,
    extraUsage: null,
    credits: null,
  }
}
