import type { UsageProviderKind, UsageSeverity } from '@preload/index'

export function providerLabel(provider: UsageProviderKind): string {
  return provider === 'claude' ? 'Claude' : 'Codex'
}

export function severityClass(severity: UsageSeverity): string {
  if (severity === 'critical') return 'bg-danger'
  if (severity === 'warning') return 'bg-warning'
  if (severity === 'unknown') return 'bg-muted'
  return 'bg-accent'
}

export function severityTextClass(severity: UsageSeverity): string {
  if (severity === 'critical') return 'text-danger'
  if (severity === 'warning') return 'text-warning'
  if (severity === 'unknown') return 'text-muted'
  return 'text-accent'
}

export function formatPercent(percent: number | null): string {
  return percent === null ? 'unknown' : `${percent}%`
}

export function formatReset(value: string | null): string | null {
  if (!value) return null
  const ts = Date.parse(value)
  if (!Number.isFinite(ts)) return null
  const deltaMs = ts - Date.now()
  if (deltaMs <= 0) return 'resets soon'
  const minutes = Math.round(deltaMs / 60_000)
  if (minutes < 60) return `resets in ${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `resets in ${hours}h`
  const days = Math.round(hours / 24)
  return `resets in ${days}d`
}

export function formatMoney(amount: number, currency: string | null): string {
  if (currency) {
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency,
        maximumFractionDigits: 2,
      }).format(amount)
    } catch {
      return `${amount.toFixed(2)} ${currency}`
    }
  }
  return amount.toFixed(2)
}
