import type {
  UsageLimitRow,
  UsageProviderKind,
  UsageSeverity,
  UsageSnapshot,
} from '@preload/index'

import { formatPercent, formatReset, providerLabel } from '@renderer/features/usage/model/formatUsage'

/** Display-only projection of a UsageLimitRow for the header chips.
 *  `id` is passed through untouched — it stays the React key; the short
 *  label is presentation and must never feed back into row identity. */
export type HeaderRow = {
  id: string
  shortLabel: string
  percent: number | null
  severity: UsageSeverity
  resetsAt: string | null
}

export type HeaderProvider = {
  provider: UsageProviderKind
  /** Two-letter chip prefix ("CL" / "CX") — fixed strings, not derived
   *  from providerLabel, because the header needs stable width. */
  code: string
  rows: HeaderRow[]
  /** Highest-percent row, used by the 'minimal' and 'providers' levels.
   *  null when every row has percent: null (unknown can't win "most
   *  constrained" — see spec §3.2). */
  worst: HeaderRow | null
}

/** Header chips can't fit "Current week (all models)". Known label
 *  shapes (see labelClaudeLimit in src/main/usage/claudeUsage.ts and
 *  labelCodexWindow in codexUsage.ts) map to fixed short forms; anything
 *  unrecognized falls back to first-word-max-6-chars so a future
 *  provider label degrades to *something* rather than blowing up the
 *  row. Display-only heuristic — do not use for identity or sorting. */
export function shortRowLabel(label: string): string {
  if (/^current session$/i.test(label)) return 'ses'
  const week = label.match(/^current week \((.+)\)$/i)
  if (week) {
    return /^all models$/i.test(week[1])
      ? 'wk'
      : week[1].toLowerCase().split(/\s+/)[0].slice(0, 6)
  }
  // Codex labels are "<base> <window>" — e.g. "Codex 5h", "Codex weekly",
  // "Additional limit 3d" (codexRowsFromRateLimit appends describeWindow's
  // suffix). The window token is the discriminating part, so search for it
  // ANYWHERE in the label, not anchored at the start: the first cut used
  // /^(\d+)h/ and /^week/, which never matched the prefixed labels and
  // collapsed "Codex 5h" and "Codex weekly" both to "codex" (caught in
  // review, PR #528). If two different base labels share a window (e.g.
  // "Codex 5h" + "Additional limit 5h") the chips do collide as "5h" —
  // the tooltip carries the full labels, which is enough at header density.
  if (/\bweekly\b|^week/i.test(label)) return 'wk'
  const window = label.match(/\b(\d+\s*[hdm])\b/i)
  if (window) return window[1].replace(/\s+/g, '').toLowerCase()
  return label.toLowerCase().split(/\s+/)[0].slice(0, 6)
}

function toHeaderRow(row: UsageLimitRow): HeaderRow {
  return {
    id: row.id,
    shortLabel: shortRowLabel(row.label),
    percent: row.percent,
    severity: row.severity,
    resetsAt: row.resetsAt,
  }
}

function worstOf(rows: HeaderRow[]): HeaderRow | null {
  let worst: HeaderRow | null = null
  for (const row of rows) {
    if (row.percent === null) continue
    if (worst === null || row.percent > (worst.percent ?? -1)) worst = row
  }
  return worst
}

/** Errored providers are dropped entirely (their chip is simply absent —
 *  error prose belongs in the modal, spec §3.2), and inactive rows are
 *  excluded at every level: the header shows limits currently in force,
 *  the modal remains the complete view. */
export function toHeaderProviders(snapshot: UsageSnapshot): HeaderProvider[] {
  const result: HeaderProvider[] = []
  for (const provider of snapshot.providers) {
    if (provider.status !== 'ok') continue
    const rows = provider.rows.filter(row => row.active).map(toHeaderRow)
    if (rows.length === 0) continue
    result.push({
      provider: provider.provider,
      code: provider.provider === 'claude' ? 'CL' : 'CX',
      rows,
      worst: worstOf(rows),
    })
  }
  return result
}

export function worstAcross(providers: HeaderProvider[]): HeaderRow | null {
  return worstOf(providers.flatMap(p => (p.worst ? [p.worst] : [])))
}

/** Full detail for the title-attribute tooltip so even 'minimal' exposes
 *  everything on hover: every provider (including errored ones, whose
 *  message only surfaces here), full labels, exact percents, resets. */
export function headerTooltip(snapshot: UsageSnapshot, stale: boolean): string {
  const lines: string[] = []
  for (const provider of snapshot.providers) {
    if (provider.status === 'error') {
      lines.push(`${providerLabel(provider.provider)}: ${provider.message}`)
      continue
    }
    for (const row of provider.rows.filter(r => r.active)) {
      const reset = formatReset(row.resetsAt)
      lines.push(
        `${providerLabel(provider.provider)} ${row.label}: ${formatPercent(row.percent)}${reset ? ` (${reset})` : ''}`,
      )
    }
  }
  if (stale) {
    const fetched = new Date(snapshot.fetchedAt)
    const time = Number.isNaN(fetched.getTime()) ? '?' : fetched.toLocaleTimeString()
    lines.push(`(stale — last updated ${time})`)
  }
  return lines.join('\n')
}
