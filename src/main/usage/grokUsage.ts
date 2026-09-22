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

const GROK_BILLING_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits'
const GROK_AUTH_PATH = join(homedir(), '.grok', 'auth.json')

// WHY a byte ceiling on a local credential file: the spec pins reads at
// ≤ 2 MiB so a hostile or corrupted auth.json cannot balloon main's memory
// before JSON.parse even runs. The real file is a few KiB.
const MAX_GROK_AUTH_BYTES = 2 * 1024 * 1024

export const GROK_LOGIN_EXPIRED_COPY = 'Grok login expired — start any Grok session to refresh it.'

type GrokCredentials = {
  key: string
  /** Null when neither the login record nor the JWT carries a readable
   *  expiry: the precheck is a UX nicety, and the server remains the real
   *  authority on stale credentials. */
  expiresAtMs: number | null
}

async function readGrokCredentials(): Promise<GrokCredentials> {
  const observed = await stat(GROK_AUTH_PATH)
  if (observed.size > MAX_GROK_AUTH_BYTES) {
    throw new Error('Grok auth.json is unexpectedly large; refusing to read it.')
  }
  const raw = await readFile(GROK_AUTH_PATH, 'utf8')
  const parsed = JSON.parse(raw) as unknown
  const root = readObject(parsed)
  // The file is a map of `issuer::uuid` → login record and can hold several
  // logins. "First non-empty key" could pin a STALE record whose expiry
  // precheck then throws forever while a valid login sits later in the file
  // (final review #8). Latest-known expiry wins; ties keep the later entry —
  // deterministic AND current.
  let best: { key: string; expiresAtMs: number | null } | null = null
  for (const value of Object.values(root)) {
    const record = readObject(value)
    const key = stringOrNull(record.key)
    if (!key) continue
    // The login RECORD's expires_at (ISO) is the authoritative field; the
    // JWT's exp claim is the fallback. (Final review #11: the earlier comment
    // claimed expires_at was seen as a JWT claim — it is not; decoding a real
    // token shows exp only, matching the record's expires_at to the second.)
    const recordExpiry = stringOrNull(record.expires_at)
    const expiresAtMs = recordExpiry !== null && Number.isFinite(Date.parse(recordExpiry))
      ? Date.parse(recordExpiry)
      : jwtExpiryMs(key)
    if (expiresAtMs === null || best === null || expiresAtMs >= (best.expiresAtMs ?? -Infinity)) {
      best = { key, expiresAtMs }
    }
  }
  if (best) return best
  throw new Error('Grok auth.json does not include a login key.')
}

/**
 * Read the expiry out of the login JWT without verifying it. Signature
 * verification needs the x.ai public keys and buys nothing here: we are only
 * deciding whether to save the user a doomed request — the billing endpoint
 * is the actual authority and rejects stale tokens itself. The real token
 * carries the standard `exp` epoch-seconds claim; this stays as the fallback
 * path behind the login record's authoritative expires_at field.
 */
export function jwtExpiryMs(token: string): number | null {
  const segments = token.split('.')
  if (segments.length !== 3) return null
  try {
    const payload = JSON.parse(Buffer.from(segments[1]!, 'base64url').toString('utf8')) as unknown
    const claims = readObject(payload)
    const iso = stringOrNull(claims.expires_at)
    if (iso) {
      const parsed = Date.parse(iso)
      if (Number.isFinite(parsed)) return parsed
    }
    const exp = numberOrNull(claims.exp)
    if (exp !== null) return exp * 1000
  } catch {
    return null
  }
  return null
}

async function fetchGrokUsagePayload(credentials: GrokCredentials): Promise<unknown> {
  const response = await fetch(GROK_BILLING_URL, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${credentials.key}`,
      // Required alongside the bearer token: without this proxy-auth header the
      // endpoint answers "no auth context" even for a valid key (spec, verified
      // against the installed Grok Build 1.0.30 binary). Header names are
      // case-insensitive on the wire (RFC 9110 §5.1) — the canonical casing is
      // used purely to match the spec letter-for-letter and end reviewer debate.
      'X-XAI-Token-Auth': 'xai-grok-cli',
      accept: 'application/json',
    },
  })
  if (!response.ok) {
    throw new Error(`Grok usage request failed with ${response.status}`)
  }
  return response.json()
}

function isoFromPeriodEnd(value: unknown): string | null {
  // The reference captures show epoch-ms numbers for currentPeriod.end; ISO
  // strings are accepted defensively so a format change degrades the reset
  // timestamp only, never the percent row it decorates.
  const numeric = numberOrNull(value)
  if (numeric !== null && numeric > 1e12) return new Date(numeric).toISOString()
  const text = stringOrNull(value)
  if (text) {
    const parsed = Date.parse(text)
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString()
  }
  return null
}

export function normalizeGrokUsagePayload(payload: unknown): UsageProviderOk {
  const root = readObject(payload)
  const config = readObject(root.config)
  const rows: ReturnType<typeof makeUsageRow>[] = []

  const creditsPercent = numberOrNull(config.creditUsagePercent)
  const period = readObject(config.currentPeriod)
  if (creditsPercent !== null) {
    rows.push(makeUsageRow({
      id: 'grok-credits',
      label: 'Credits (current period)',
      percent: creditsPercent,
      resetsAt: isoFromPeriodEnd(period.end),
      scope: 'all-models',
      // Exhaustion on the shared credit pool legitimately means "switch
      // provider"; per-product rows below carry the family detail instead.
      detail: stringOrNull(period.type),
    }))
  }

  for (const entry of readArray(config.productUsage)) {
    const product = readObject(entry)
    const label = stringOrNull(product.product)
    const percent = numberOrNull(product.usagePercent)
    if (label === null || percent === null) continue
    rows.push(makeUsageRow({
      id: `grok-product-${label}`,
      label,
      percent,
      scope: 'model-family',
      detail: null,
    }))
  }

  const normalized = emptyProviderOk('grok', '~/.grok/auth.json')
  return {
    ...normalized,
    plan: stringOrNull(root.subscriptionTier),
    rows: sortUsageRows(rows),
  }
}

export async function readGrokUsage(): Promise<UsageProviderOk> {
  const credentials = await readGrokCredentials()
  // Precheck BEFORE the request: an expired login is the common steady state
  // (the CLI only refreshes auth.json when a Grok session runs), and the
  // copy tells the user the actual fix instead of a generic auth failure.
  // The poller retries every 60 s, so the row self-heals after any session.
  if (credentials.expiresAtMs !== null && credentials.expiresAtMs <= Date.now()) {
    throw new Error(GROK_LOGIN_EXPIRED_COPY)
  }
  const payload = await fetchGrokUsagePayload(credentials)
  return normalizeGrokUsagePayload(payload)
}
