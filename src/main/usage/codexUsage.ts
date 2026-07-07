import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { UsageProviderOk } from '@shared/types/usage.js'

import {
  emptyProviderOk,
  isoFromSecondsFromNow,
  isoFromUnixSeconds,
  makeUsageRow,
  percentFromRatio,
  readArray,
  readObject,
  sortUsageRows,
  spendFromObject,
  stringOrNull,
} from '@main/usage/normalize.js'

const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const CODEX_AUTH_PATH = join(homedir(), '.codex', 'auth.json')

type CodexCredentials = {
  accessToken: string
  accountId: string | null
}

async function readCodexCredentials(): Promise<CodexCredentials> {
  // WHY Agent Code reads ~/.codex/auth.json on demand instead of copying it:
  //
  // Codex CLI already owns the user's auth lifecycle. The desktop app only
  // needs a bearer token for the duration of this usage request, and the token
  // can change when the CLI refreshes or the user switches accounts. Reading
  // the provider's source of truth at call time keeps `/usage` accurate without
  // inventing encryption, sync, migration, or token-revocation semantics here.
  const raw = await readFile(CODEX_AUTH_PATH, 'utf8')
  const parsed = JSON.parse(raw) as unknown
  const root = readObject(parsed)
  const tokens = readObject(root.tokens)
  const accessToken = stringOrNull(tokens.access_token)
  if (!accessToken) throw new Error('Codex auth.json does not include an access token.')
  return {
    accessToken,
    accountId: stringOrNull(tokens.account_id),
  }
}

async function fetchCodexUsagePayload(credentials: CodexCredentials): Promise<unknown> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${credentials.accessToken}`,
    accept: 'application/json',
  }
  if (credentials.accountId) headers['chatgpt-account-id'] = credentials.accountId
  const response = await fetch(CODEX_USAGE_URL, {
    method: 'GET',
    headers,
  })
  if (!response.ok) {
    throw new Error(`Codex usage request failed with ${response.status}`)
  }
  return response.json()
}

function labelCodexWindow(value: Record<string, unknown>, fallback: string): string {
  return (
    stringOrNull(value.label) ??
    stringOrNull(value.display_name) ??
    stringOrNull(value.name) ??
    stringOrNull(value.bucket) ??
    fallback
  )
}

function describeWindow(window: Record<string, unknown>): string | null {
  const seconds = typeof window.limit_window_seconds === 'number'
    ? window.limit_window_seconds
    : null
  if (!seconds) return null
  if (seconds % 86_400 === 0) {
    const days = seconds / 86_400
    return days === 7 ? 'weekly' : `${days}d`
  }
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`
  return `${Math.round(seconds / 60)}m`
}

function codexRowFromWindow(
  value: unknown,
  index: number,
  fallback: string,
): ReturnType<typeof makeUsageRow> {
  const obj = readObject(value)
  const percent = percentFromRatio(
    obj.percent_used ??
    obj.percentage ??
    obj.used_percent ??
    obj.used_fraction ??
    obj.ratio,
  )
  const resetsAt =
    stringOrNull(obj.resets_at) ??
    stringOrNull(obj.reset_at) ??
    isoFromUnixSeconds(obj.reset_time) ??
    isoFromUnixSeconds(obj.reset_at_unix) ??
    isoFromUnixSeconds(obj.reset_at) ??
    isoFromSecondsFromNow(obj.reset_after_seconds)
  const remaining = obj.remaining
  const limit = obj.limit
  const window = describeWindow(obj)
  const detail =
    typeof remaining === 'number' && typeof limit === 'number'
      ? `${remaining} remaining of ${limit}`
      : stringOrNull(obj.description) ?? stringOrNull(obj.message) ?? (window ? `${window} window` : null)
  return makeUsageRow({
    id: stringOrNull(obj.id) ?? `codex-limit-${index}`,
    label: labelCodexWindow(obj, fallback),
    percent,
    resetsAt,
    active: obj.active !== false,
    detail,
  })
}

function codexRowsFromRateLimit(
  value: unknown,
  baseLabel: string,
  startIndex: number,
): ReturnType<typeof makeUsageRow>[] {
  const rateLimit = readObject(value)
  const rows: ReturnType<typeof makeUsageRow>[] = []
  for (const key of ['primary_window', 'secondary_window'] as const) {
    const window = readObject(rateLimit[key])
    if (Object.keys(window).length === 0) continue
    const windowLabel = describeWindow(window)
    rows.push(codexRowFromWindow(
      {
        ...window,
        id: `${baseLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${key.replace(/_/g, '-')}`,
        label: windowLabel ? `${baseLabel} ${windowLabel}` : baseLabel,
        active: rateLimit.allowed !== false,
      },
      startIndex + rows.length,
      baseLabel,
    ))
  }
  return rows
}

export function normalizeCodexUsagePayload(payload: unknown): UsageProviderOk {
  const root = readObject(payload)
  const rows: ReturnType<typeof makeUsageRow>[] = []

  const primary = root.rate_limit
  if (primary) {
    rows.push(...codexRowsFromRateLimit(primary, 'Codex', rows.length))
  }

  for (const entry of readArray(root.additional_rate_limits)) {
    const item = readObject(entry)
    const label =
      stringOrNull(item.limit_name) ??
      stringOrNull(item.metered_feature) ??
      'Additional limit'
    const rateLimit = item.rate_limit ? item.rate_limit : item
    rows.push(...codexRowsFromRateLimit(rateLimit, label, rows.length))
  }

  for (const entry of readArray(root.limits)) {
    rows.push(codexRowFromWindow(entry, rows.length, 'Limit'))
  }

  const normalized = emptyProviderOk('codex', '~/.codex/auth.json')
  return {
    ...normalized,
    plan: stringOrNull(root.plan_type) ?? stringOrNull(root.plan) ?? stringOrNull(root.tier),
    rows: sortUsageRows(rows),
    spend: spendFromObject(root.spend),
    extraUsage: spendFromObject(root.extra_usage),
    credits: spendFromObject(root.credits),
  }
}

export async function readCodexUsage(): Promise<UsageProviderOk> {
  const credentials = await readCodexCredentials()
  const payload = await fetchCodexUsagePayload(credentials)
  return normalizeCodexUsagePayload(payload)
}
