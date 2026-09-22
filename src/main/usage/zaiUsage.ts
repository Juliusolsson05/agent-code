import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { UsageProviderOk } from '@shared/types/usage.js'

import {
  emptyProviderOk,
  makeUsageRow,
  numberOrNull,
  readArray,
  readObject,
  sortUsageRows,
  stringOrNull,
} from '@main/usage/normalize.js'

const ZAI_USAGE_URL = 'https://api.z.ai/api/monitor/usage/quota/limit'
const OPENCODE_AUTH_PATH = join(homedir(), '.local', 'share', 'opencode', 'auth.json')

// Same ceiling rationale as the Grok reader: bound the credential read before
// JSON.parse so a corrupted file cannot balloon main's memory.
const MAX_OPENCODE_AUTH_BYTES = 2 * 1024 * 1024

// Verified live 2026-09-20 (spec): `unit` identifies the window kind and
// z.ai may REORDER limits[]. Positional classification would silently swap
// the 5-hour and 7-day rows on a server-side reshuffle; only `unit` is truth.
const ZAI_UNIT_WINDOW: Record<number, { id: string; label: string }> = {
  3: { id: 'zai-5h', label: '5-hour window' },
  6: { id: 'zai-7d', label: '7-day window' },
}

async function readZaiKey(): Promise<string> {
  const observed = await stat(OPENCODE_AUTH_PATH)
  if (observed.size > MAX_OPENCODE_AUTH_BYTES) {
    throw new Error('OpenCode auth.json is unexpectedly large; refusing to read it.')
  }
  const raw = await readFile(OPENCODE_AUTH_PATH, 'utf8')
  const parsed = JSON.parse(raw) as unknown
  // `zai-coding-plan` is the provider id OpenCode's /connect writes for the
  // GLM Coding Plan; only that record carries a raw API key.
  const record = readObject(readObject(parsed)['zai-coding-plan'])
  const key = stringOrNull(record.key)
  if (!key) throw new Error('opencode auth.json has no zai-coding-plan key.')
  return key
}

async function fetchZaiUsagePayload(key: string): Promise<unknown> {
  const response = await fetch(ZAI_USAGE_URL, {
    method: 'GET',
    // Verified quirk: the quota endpoint wants the RAW key. A standard
    // `Bearer <key>` prefix answers 401 — this is the one reader that must
    // not follow the codex/claude header shape.
    headers: { authorization: key, accept: 'application/json' },
  })
  if (!response.ok) {
    throw new Error(`z.ai usage request failed with ${response.status}`)
  }
  return response.json()
}

/**
 * Normalize the quota envelope. Three failure shapes are contract, not noise:
 * 1. HTTP 200 + `success:false`/non-200 `code` — z.ai wraps backend failures
 *    in a 200 (verified: {"code":500,"msg":"404 NOT_FOUND",…}); surfacing it
 *    as an ok row with empty usage would read as "plenty of quota left".
 * 2. A `limits[]` entry whose `unit` we cannot name — the mapping above is
 *    exhaustive by evidence, and an unknown window is z.ai drift, not a guess
 *    we can label. Error row.
 * 3. Both windows absent — an empty plan would repeat failure shape 1's lie.
 */
export function normalizeZaiUsagePayload(payload: unknown): UsageProviderOk {
  const root = readObject(payload)
  if (root.success !== true || numberOrNull(root.code) !== 200) {
    throw new Error(stringOrNull(root.msg)
      ? `z.ai quota endpoint reported a failure: ${stringOrNull(root.msg)}`
      : 'z.ai quota endpoint reported a failure.')
  }
  const data = readObject(root.data)
  const limits = readArray(data.limits)
  if (limits.length === 0) throw new Error('z.ai quota response carried no limits.')

  const rows: ReturnType<typeof makeUsageRow>[] = []
  for (const entry of limits) {
    const limit = readObject(entry)
    const unit = numberOrNull(limit.unit)
    const percentage = numberOrNull(limit.percentage)
    const reset = numberOrNull(limit.nextResetTime)
    // TIME_LIMIT (monthly MCP ceiling) carries no percentage quota in the
    // observed shape and its unit is outside the window map; a row without a
    // percent cannot drive exhaustion, so skip it BEFORE the unknown-unit
    // drift check rather than letting it fall through as a false error.
    if (stringOrNull(limit.type) === 'TIME_LIMIT' && percentage === null) continue
    const window = unit !== null ? ZAI_UNIT_WINDOW[unit] : undefined
    if (!window) throw new Error(`z.ai quota response carried an unrecognized window (unit ${String(limit.unit)}).`)
    rows.push(makeUsageRow({
      id: window.id,
      label: window.label,
      percent: percentage,
      resetsAt: reset !== null && reset > 1e12 ? new Date(reset).toISOString() : null,
      // The coding plan quota is one shared pool across every GLM model, so
      // either window exhausting means "switch provider", exactly what the
      // all-models scope tells the exhaustion logic.
      scope: 'all-models',
      detail: `of ${numberOrNull(limit.number) ?? '?'} credits · ${numberOrNull(limit.remaining) ?? '?'} left`,
    }))
  }
  if (rows.length === 0) throw new Error('z.ai quota response carried no usable limits.')

  const normalized = emptyProviderOk('opencode:zai', 'z.ai Coding Plan (OpenCode)')
  return {
    ...normalized,
    plan: stringOrNull(data.level),
    rows: sortUsageRows(rows),
  }
}

/** Settings hint support: does the OpenCode credential store hold a z.ai
 *  coding-plan key? Read-only, no network, cheap enough for every snapshot
 *  rebuild. The dropdown stays greyed until this is true — selecting z.ai
 *  with no credential would render a permanently-erroring usage row. */
export async function probeZaiCredential(): Promise<boolean> {
  try {
    const observed = await stat(OPENCODE_AUTH_PATH)
    if (observed.size > MAX_OPENCODE_AUTH_BYTES) return false
    const parsed = JSON.parse(await readFile(OPENCODE_AUTH_PATH, 'utf8')) as unknown
    return Boolean(stringOrNull(readObject(readObject(parsed)['zai-coding-plan']).key))
  } catch {
    return false
  }
}

export async function readZaiUsage(): Promise<UsageProviderOk> {
  const key = await readZaiKey()
  const payload = await fetchZaiUsagePayload(key)
  return normalizeZaiUsagePayload(payload)
}
