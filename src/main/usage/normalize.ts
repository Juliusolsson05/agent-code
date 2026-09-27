import type {
  UsageLimitRow,
  UsageLimitScope,
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
  // Optional with an `unknown` default rather than required, deliberately: only
  // the per-provider normalizers can tell a shared window from a per-family one
  // (Claude reads `kind`, Codex reads which part of the payload the window came
  // from). A caller that cannot classify its row must say so, not guess — and
  // `unknown` never counts as exhaustion downstream, so an unclassified row can
  // only fail to move agents, never move the wrong ones.
  scope?: UsageLimitScope
}): UsageLimitRow {
  return {
    id: args.id,
    label: args.label,
    percent: args.percent,
    severity: severityFromPercent(args.percent),
    resetsAt: args.resetsAt ?? null,
    active: args.active ?? true,
    detail: args.detail ?? null,
    scope: args.scope ?? 'unknown',
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

/**
 * The whole sentences Agent Code itself throws from the usage readers, and
 * nothing else (#1451 q132). Each is fixed text with no path, token or
 * provider-supplied part; see sanitizeUsageError. Kept here, not imported from
 * each reader, because the readers import this module.
 */
const FIRST_PARTY_USAGE_MESSAGES: ReadonlySet<string> = new Set([
  'Claude usage currently requires macOS Keychain credentials.',
  'Claude Keychain credentials were empty.',
  'Claude Keychain credentials do not include an OAuth access token.',
  'Codex auth.json does not include an access token.',
  'Grok auth.json is unexpectedly large; refusing to read it.',
  'Grok auth.json does not include a login key.',
  'OpenCode auth.json is unexpectedly large; refusing to read it.',
  'opencode auth.json has no zai-coding-plan key.',
  // grokUsage.ts GROK_LOGIN_EXPIRED_COPY: its copy tells the user the fix.
  'Grok login expired — start any Grok session to refresh it.',
])

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
  // EXACT first-party sentences only (#1451 steering q132, SECURITY). The
  // earlier gates were prefixes and substrings — "contains Keychain", "starts
  // with Codex auth.json", "starts with Grok login expired" — and a prefix
  // proves nothing about the rest of the sentence: "Codex auth.json
  // /Users/alice/.codex/auth.json token=abc" passed whole, and the usage MCP
  // domain hands this row to agents. A message is kept only when it IS one of
  // the sentences Agent Code throws, character for character; everything else
  // is fixed text. A throw site whose wording drifts falls to the fixed text,
  // which is the safe direction.
  if (FIRST_PARTY_USAGE_MESSAGES.has(message)) return message
  if (/keychain/i.test(message)) return "Claude's Keychain credentials could not be read."
  if (message.includes('auth.json')) return 'Its auth file (auth.json) could not be read.'
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
