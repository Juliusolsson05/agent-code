import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import type { UsageProviderOk } from '@shared/types/usage.js'

import {
  emptyProviderOk,
  isoFromUnixSeconds,
  makeUsageRow,
  percentFromRatio,
  readArray,
  readObject,
  sortUsageRows,
  spendFromObject,
  stringOrNull,
} from '@main/usage/normalize.js'

const execFileAsync = promisify(execFile)
const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials'

type ClaudeCredentials = {
  accessToken: string
  // WHY subscriptionType is carried out of the Keychain read even though the
  // OAuth /usage payload sometimes also returns a plan-ish field: the raw
  // response only reliably includes plan info as top-level `plan`/`tier` on
  // some accounts. Every account with a Claude Code Keychain entry has a
  // `subscriptionType` string ("max_20x", "pro", …) directly on the credential
  // blob, so surfacing that as a fallback keeps the modal from showing
  // "PLAN unknown" for the common case where the API omits it.
  subscriptionType: string | null
}

async function readClaudeCredentials(): Promise<ClaudeCredentials> {
  if (process.platform !== 'darwin') {
    throw new Error('Claude usage currently requires macOS Keychain credentials.')
  }
  const args = ['find-generic-password', '-s', CLAUDE_KEYCHAIN_SERVICE, '-w']
  // WHY we read Claude Code's Keychain item at request time:
  //
  // Agent Code should never become a second credential store for another
  // provider. Claude Code already owns token refresh and revocation in the
  // Keychain; this feature only borrows the freshest access token long enough
  // to ask the same usage endpoint Claude's own `/usage` command calls. That
  // keeps revocation, account switching, and expiry semantics aligned with the
  // provider instead of snapshotting a secret into Agent Code state.
  const { stdout } = await execFileAsync('security', args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  })
  const raw = stdout.trim()
  if (!raw) throw new Error('Claude Keychain credentials were empty.')
  const parsed = JSON.parse(raw) as unknown
  const root = readObject(parsed)
  const oauth = readObject(root.claudeAiOauth)
  const accessToken = stringOrNull(oauth.accessToken)
  if (!accessToken) throw new Error('Claude Keychain credentials do not include an OAuth access token.')
  const subscriptionType = stringOrNull(oauth.subscriptionType)
  return { accessToken, subscriptionType }
}

async function fetchClaudeUsagePayload(accessToken: string): Promise<unknown> {
  const response = await fetch(CLAUDE_USAGE_URL, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/json',
    },
  })
  if (!response.ok) {
    throw new Error(`Claude usage request failed with ${response.status}`)
  }
  return response.json()
}

// WHY this label function switches on `kind` before anything else:
//
// The first cut of this code fell through a chain of stringOrNull() candidates
// (name → label → display_name → group → kind) and returned the first hit.
// That looked reasonable in the abstract but produced awful labels against the
// real payload, which has NO `name`/`label`/`display_name`, only `kind` and
// `group`. Two of three rows share `group: "weekly"`, so the UI rendered as:
//   weekly | weekly | session
// which is both duplicative and useless — the second row is actually the
// per-model weekly window (Fable) and the payload only exposes that through
// `scope.model.display_name`.
//
// The observed shape (from a real Max account) is:
//   { kind: "session",        group: "session", percent, resets_at, is_active }
//   { kind: "weekly_all",     group: "weekly",  percent, resets_at, is_active }
//   { kind: "weekly_scoped",  group: "weekly",  scope: { model: { id, display_name } }, ... }
// Switching on `kind` and using `scope.model.display_name` for the scoped case
// gives readable, distinct labels:
//   "Current session" | "Current week (all models)" | "Current week (Fable)"
//
// The `name`/`label`/`display_name` fallback path is preserved for the day
// Anthropic adds a server-supplied human label to the payload — if it appears,
// prefer it verbatim rather than second-guessing the naming.
function labelClaudeLimit(limit: Record<string, unknown>, index: number): string {
  const explicit =
    stringOrNull(limit.name) ??
    stringOrNull(limit.label) ??
    stringOrNull(limit.display_name)
  if (explicit) return explicit

  const kind = stringOrNull(limit.kind)
  const scope = readObject(limit.scope)
  const modelObject = readObject(scope.model)
  const modelName =
    stringOrNull(modelObject.display_name) ??
    stringOrNull(modelObject.id) ??
    stringOrNull(scope.model) ??
    stringOrNull(scope.model_name)

  if (kind === 'session') return 'Current session'
  if (kind === 'weekly_all') return 'Current week (all models)'
  if (kind === 'weekly_scoped') {
    return modelName ? `Current week (${modelName})` : 'Current week (scoped)'
  }

  // Best-effort fallback for a shape we haven't seen — combine whatever scope
  // information exists so the row still says something useful rather than
  // showing "Limit 3". Prefer `kind` over `group` here because `kind` is the
  // more discriminating field (kind: weekly_all vs weekly_scoped both share
  // group: weekly) — that was the whole reason the first cut of this code
  // produced duplicate "weekly | weekly" labels.
  const group = stringOrNull(limit.group)
  const surfaceObject = readObject(scope.surface)
  const surface =
    stringOrNull(surfaceObject.display_name) ??
    stringOrNull(surfaceObject.id) ??
    stringOrNull(scope.surface)
  const duration = stringOrNull(scope.duration) ?? stringOrNull(limit.duration)
  const pieces = [kind ?? group, duration, modelName, surface].filter(Boolean)
  if (pieces.length > 0) return pieces.join(' · ')
  return `Limit ${index + 1}`
}

type ClaudeNormalizeOptions = {
  // WHY this is a separate param instead of stuffed into the payload: keeping
  // the pure-normalization tests fed purely by API-shaped payloads means the
  // Keychain-derived plan fallback is testable in isolation without pretending
  // the wire response carries it.
  fallbackPlan?: string | null
}

export function normalizeClaudeUsagePayload(
  payload: unknown,
  options: ClaudeNormalizeOptions = {},
): UsageProviderOk {
  const root = readObject(payload)
  const rows = readArray(root.limits).map((entry, index) => {
    const limit = readObject(entry)
    const percent = percentFromRatio(
      limit.percent ??
      limit.percent_used ??
      limit.percentage ??
      limit.usage_percent ??
      limit.used_fraction ??
      limit.ratio,
    )
    const resetsAt =
      stringOrNull(limit.resets_at) ??
      stringOrNull(limit.reset_at) ??
      isoFromUnixSeconds(limit.reset_time) ??
      isoFromUnixSeconds(limit.resets_at_unix)
    const detail =
      stringOrNull(limit.description) ??
      stringOrNull(limit.message) ??
      stringOrNull(limit.scope_description)
    return makeUsageRow({
      id: stringOrNull(limit.id) ?? `claude-limit-${index}`,
      label: labelClaudeLimit(limit, index),
      percent,
      resetsAt,
      active: limit.is_active !== false && limit.active !== false,
      detail,
    })
  })

  const normalized = emptyProviderOk('claude', 'Claude Code Keychain')
  const plan =
    stringOrNull(root.plan) ??
    stringOrNull(root.plan_type) ??
    stringOrNull(root.tier) ??
    stringOrNull(options.fallbackPlan) ??
    null
  return {
    ...normalized,
    plan,
    rows: sortUsageRows(rows),
    spend: spendFromObject(root.spend),
    extraUsage: spendFromObject(root.extra_usage),
    credits: spendFromObject(root.credits),
  }
}

export async function readClaudeUsage(): Promise<UsageProviderOk> {
  const credentials = await readClaudeCredentials()
  const payload = await fetchClaudeUsagePayload(credentials.accessToken)
  return normalizeClaudeUsagePayload(payload, { fallbackPlan: credentials.subscriptionType })
}
