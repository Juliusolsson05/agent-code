/**
 * Shared environment-hygiene helpers for local Claude & Codex proxies (#1552).
 *
 * WHY these live in one shared module:
 *   Both `ClaudeSession` (mitmproxy) and `CodexSession` (ResponsesProxy) face
 *   the exact same two corporate/network environment hazards:
 *     1. Existing HTTP(S)_PROXY variables — chaining our local proxy in front
 *        of a corporate proxy (or having ResponsesProxy's Node `fetch()` ignore
 *        `HTTPS_PROXY` altogether) breaks outbound API requests instead of
 *        observing them.
 *     2. Existing NO_PROXY / no_proxy variables — overwriting them with a bare
 *        loopback list drops the user's internal corporate domains, breaking
 *        MCP servers, private registries, and internal hosts reachable from
 *        the agent's shell.
 */

export const LOOPBACK_NO_PROXY_HOSTS = ['localhost', '127.0.0.1', '::1'] as const

const CORPORATE_PROXY_ENV_KEYS = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
] as const

/**
 * Returns true if the child environment already configures an upstream HTTP(S)
 * proxy. Whitespace-only values are treated as unset.
 */
export function hasCorporateProxyEnv(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return CORPORATE_PROXY_ENV_KEYS.some(key => {
    const value = env[key]
    return typeof value === 'string' && value.trim().length > 0
  })
}

/**
 * Merge loopback bypass hosts into any existing `NO_PROXY` / `no_proxy`
 * values without clobbering user entries or introducing duplicates.
 *
 * WHY we read BOTH casings and return a single merged string for both:
 *   Tools disagree on whether `NO_PROXY` or `no_proxy` wins (curl checks
 *   lowercase first, Node/undici and Go check both, Python urllib prefers
 *   lowercase). Merging the union of both existing values and writing the
 *   result to both `NO_PROXY` and `no_proxy` preserves every user-configured
 *   bypass entry regardless of which casing they set.
 */
export function mergeNoProxy(
  env: Readonly<Record<string, string | undefined>>,
  requiredHosts: readonly string[] = LOOPBACK_NO_PROXY_HOSTS,
): string {
  const entries: string[] = []
  const seen = new Set<string>()

  const add = (raw: string | undefined): void => {
    if (!raw) return
    for (const part of raw.split(',')) {
      const trimmed = part.trim()
      if (!trimmed) continue
      const key = trimmed.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      entries.push(trimmed)
    }
  }

  add(env.NO_PROXY)
  add(env.no_proxy)
  for (const host of requiredHosts) {
    add(host)
  }

  return entries.join(',')
}
