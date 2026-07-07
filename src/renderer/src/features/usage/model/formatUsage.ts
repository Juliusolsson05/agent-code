import type { CSSProperties } from 'react'

import type { UsageProviderKind, UsageSeverity } from '@preload/index'

export function providerLabel(provider: UsageProviderKind): string {
  return provider === 'claude' ? 'Claude' : 'Codex'
}

// WHY we return CSS variables + inline styles instead of Tailwind utility classes:
//
// The renderer theme (src/renderer/src/styles.css) defines --theme-accent,
// --theme-danger, --theme-muted per theme, but has no `warning` token — every
// palette (dark, dim, tokyo, void, kraft, muji, paper, ...) would need a new
// hex added to stay consistent. The first cut used `bg-warning`/`text-warning`
// Tailwind classes, but those classes have nothing bound in @theme inline, so
// the 75%-full bar rendered invisible (no background) and the percent text
// showed in the default ink color, making a "critical" and "warning" row look
// identical apart from the numeric percent.
//
// Instead of touching every theme block for a single accent, we route
// severity → an inline style object. Critical/unknown/ok pick up the existing
// theme variables so they still respond to theme switching; warning uses a
// hard-coded amber that reads well on both light and dark surfaces. If a
// future theme wants a bespoke warning tint, adding `--theme-warning` to the
// palette and swapping the hex for `var(--theme-warning, #d97706)` is the
// one-line follow-up.
const WARNING_HEX = '#d97706'

function severityHex(severity: UsageSeverity): string {
  if (severity === 'critical') return 'var(--theme-danger)'
  if (severity === 'warning') return WARNING_HEX
  if (severity === 'unknown') return 'var(--theme-muted)'
  return 'var(--theme-accent)'
}

export function severityBarStyle(severity: UsageSeverity): CSSProperties {
  return { backgroundColor: severityHex(severity) }
}

export function severityTextStyle(severity: UsageSeverity): CSSProperties {
  return { color: severityHex(severity) }
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
