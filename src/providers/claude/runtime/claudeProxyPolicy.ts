import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { hasCorporateProxyEnv, mergeNoProxy } from '@providers/shared/runtime/proxyEnv.js'

/**
 * Compatibility and environment-hygiene policy for Claude's local mitmproxy
 * (#1552).
 *
 * WHY this policy is evaluated BEFORE spawning mitmdump:
 *   Agent Code's mitmproxy is purely an observational enhancement for semantic
 *   streaming; Claude Code works completely fine without it (screen-driven +
 *   JSONL semantics). Spawning mitmdump in environments where it cannot
 *   safely intercept Anthropic traffic — corporate proxies, Bedrock/Vertex/
 *   Foundry cloud backends, or local/plain-HTTP gateways — either breaks
 *   outbound connectivity outright or wastes a subprocess for zero captured
 *   events. Detecting those setups up front lets ClaudeSession skip the proxy
 *   cleanly and spawn Claude directly.
 */

export type ClaudeProxyCompatibilityDecision =
  | { allow: true }
  | {
      allow: false
      reason: 'corporate-proxy-env' | 'non-anthropic-backend' | 'local-or-http-base-url'
      detail: string
    }

const NON_ANTHROPIC_BACKEND_FLAGS = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
] as const

const FALSY_ENV_VALUES = new Set(['', '0', 'false', 'no', 'off'])

function isTruthyEnvFlag(value: string | undefined): boolean {
  if (typeof value !== 'string') return false
  return !FALSY_ENV_VALUES.has(value.trim().toLowerCase())
}

function isLocalOrPlainHttpBaseUrl(rawUrl: string): boolean {
  const trimmed = rawUrl.trim()
  if (!trimmed) return false
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol === 'http:') return true
    const host = parsed.hostname.toLowerCase()
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === '[::1]' ||
      host.endsWith('.localhost')
    ) {
      return true
    }
    return false
  } catch {
    // Fallback for malformed URLs that still start with http:// or reference
    // loopback explicitly — fail safe by skipping MITM rather than guessing.
    const lower = trimmed.toLowerCase()
    return (
      lower.startsWith('http://') ||
      lower.includes('localhost') ||
      lower.includes('127.0.0.1') ||
      lower.includes('::1')
    )
  }
}

export function evaluateClaudeProxyCompatibility(
  env: Readonly<Record<string, string | undefined>>,
): ClaudeProxyCompatibilityDecision {
  if (hasCorporateProxyEnv(env)) {
    return {
      allow: false,
      reason: 'corporate-proxy-env',
      detail: 'Existing HTTP(S)_PROXY environment variable detected; skipping local mitmproxy.',
    }
  }

  for (const flag of NON_ANTHROPIC_BACKEND_FLAGS) {
    if (isTruthyEnvFlag(env[flag])) {
      return {
        allow: false,
        reason: 'non-anthropic-backend',
        detail: `${flag} is enabled; skipping local Anthropic mitmproxy.`,
      }
    }
  }

  const baseUrl = env.ANTHROPIC_BASE_URL
  if (typeof baseUrl === 'string' && isLocalOrPlainHttpBaseUrl(baseUrl)) {
    return {
      allow: false,
      reason: 'local-or-http-base-url',
      detail: 'ANTHROPIC_BASE_URL points to plain HTTP or loopback; skipping local mitmproxy.',
    }
  }

  return { allow: true }
}

/**
 * Build the child process environment for a proxied Claude spawn.
 *
 * WHY NODE_EXTRA_CA_CERTS is merged into a combined PEM instead of overwritten:
 *   Users behind enterprise TLS inspection or private registries often set
 *   `NODE_EXTRA_CA_CERTS` to trust their corporate root CA. Overwriting it
 *   with only mitmproxy's CA silently breaks every Node tool spawned inside
 *   the session that talks to internal HTTPS endpoints. Concatenating the
 *   user's bundle and mitmproxy's CA into a per-run PEM inside `proxyInfo.workDir`
 *   preserves both trust roots. If the user's CA file cannot be read, we
 *   intentionally throw so `ClaudeSession.start()`'s fail-open catch tears
 *   down the proxy and spawns Claude directly with the user's untouched env.
 */
export async function buildClaudeProxyEnv(
  cleanEnv: Readonly<Record<string, string>>,
  proxyInfo: { proxyUrl: string; caCertPath: string; workDir: string },
): Promise<Record<string, string>> {
  const proxyEnv: Record<string, string> = { ...cleanEnv }
  proxyEnv.HTTPS_PROXY = proxyInfo.proxyUrl
  proxyEnv.https_proxy = proxyInfo.proxyUrl
  proxyEnv.HTTP_PROXY = proxyInfo.proxyUrl
  proxyEnv.http_proxy = proxyInfo.proxyUrl

  const mergedNoProxy = mergeNoProxy(cleanEnv)
  proxyEnv.NO_PROXY = mergedNoProxy
  proxyEnv.no_proxy = mergedNoProxy

  const userExtraCa = cleanEnv.NODE_EXTRA_CA_CERTS?.trim()
  if (userExtraCa) {
    const [userPem, mitmPem] = await Promise.all([
      readFile(userExtraCa, 'utf8'),
      readFile(proxyInfo.caCertPath, 'utf8'),
    ])
    const combinedPath = join(proxyInfo.workDir, 'combined-extra-ca-certs.pem')
    const combinedPem = `${userPem.trimEnd()}\n${mitmPem.trimStart()}`
    await writeFile(combinedPath, combinedPem, { encoding: 'utf8', mode: 0o600 })
    proxyEnv.NODE_EXTRA_CA_CERTS = combinedPath
  } else {
    proxyEnv.NODE_EXTRA_CA_CERTS = proxyInfo.caCertPath
  }

  return proxyEnv
}
