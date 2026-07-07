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
  return { accessToken }
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

function labelClaudeLimit(limit: Record<string, unknown>, index: number): string {
  const name =
    stringOrNull(limit.name) ??
    stringOrNull(limit.label) ??
    stringOrNull(limit.display_name) ??
    stringOrNull(limit.group) ??
    stringOrNull(limit.kind)
  if (name) return name

  const scope = readObject(limit.scope)
  const modelObject = readObject(scope.model)
  const surfaceObject = readObject(scope.surface)
  const model =
    stringOrNull(modelObject.display_name) ??
    stringOrNull(modelObject.id) ??
    stringOrNull(scope.model) ??
    stringOrNull(scope.model_name)
  const surface =
    stringOrNull(surfaceObject.display_name) ??
    stringOrNull(surfaceObject.id) ??
    stringOrNull(scope.surface)
  const duration = stringOrNull(scope.duration) ?? stringOrNull(limit.duration)
  const pieces = [duration, model, surface].filter(Boolean)
  if (pieces.length > 0) return pieces.join(' · ')
  return `Limit ${index + 1}`
}

export function normalizeClaudeUsagePayload(payload: unknown): UsageProviderOk {
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
  return {
    ...normalized,
    plan: stringOrNull(root.plan) ?? stringOrNull(root.plan_type) ?? stringOrNull(root.tier),
    rows: sortUsageRows(rows),
    spend: spendFromObject(root.spend),
    extraUsage: spendFromObject(root.extra_usage),
    credits: spendFromObject(root.credits),
  }
}

export async function readClaudeUsage(): Promise<UsageProviderOk> {
  const credentials = await readClaudeCredentials()
  const payload = await fetchClaudeUsagePayload(credentials.accessToken)
  return normalizeClaudeUsagePayload(payload)
}
