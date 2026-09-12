import {
  BUILT_IN_MCP_DOMAINS,
  filterBuiltInMcpDomainsForProvider,
  normalizeBuiltInMcpDomains,
} from '@mcp/shared/types'
import type { BuiltInMcpDomain, BuiltInMcpOverrides } from '@mcp/shared/types'
import type { AgentProviderKind } from '@shared/types/providerKind'

export function normalizeSessionBuiltInMcpDomains(
  value: unknown,
): BuiltInMcpDomain[] | undefined {
  if (!Array.isArray(value)) return undefined
  // Empty remains a real observed capability snapshot: an adopted process
  // with no MCPs must not appear enabled just because global settings changed.
  // Desired next-launch choices live separately in builtInMcpOverrides.
  return normalizeBuiltInMcpDomains(value)
}

/**
 * Which built-in MCP capabilities a provider process should launch with.
 *
 * Two modes, and which one you want depends on whether you are DECIDING a
 * launch or DESCRIBING one that already happened:
 *
 *  - Pass `sessionOverrides` to decide a launch. Global Settings supply the
 *    baseline and the pane's per-domain choices add to or subtract from it, so
 *    a Settings change reaches every agent at its next provider start — which
 *    is the whole point of #904 — while an explicit per-agent decision survives
 *    that change in either direction.
 *  - Omit it to describe an existing process: `sessionDomains` is then the
 *    authority and `defaultDomains` should be `[]`. Recovery uses this to
 *    record what an ADOPTED backend genuinely has, because a process already
 *    running cannot gain MCP servers from a preference edit.
 *
 * Provider filtering applies last in both modes: capability support belongs to
 * the launcher, never to the stored preference.
 */
export function resolveSessionBuiltInMcpDomains(params: {
  provider: AgentProviderKind
  sessionDomains?: unknown
  defaultDomains: unknown
  sessionOverrides?: BuiltInMcpOverrides
}): BuiltInMcpDomain[] {
  if (params.sessionOverrides !== undefined) {
    const requested = new Set(normalizeBuiltInMcpDomains(params.defaultDomains))
    for (const domain of BUILT_IN_MCP_DOMAINS) {
      if (params.sessionOverrides[domain] === true) requested.add(domain)
      else if (params.sessionOverrides[domain] === false) requested.delete(domain)
    }
    return filterBuiltInMcpDomainsForProvider(params.provider, [...requested])
  }
  const explicit = normalizeSessionBuiltInMcpDomains(params.sessionDomains)
  // An observed list is a complete snapshot, never a partial overlay. Merging
  // defaults into it would report tools the live process does not actually
  // serve; only an absent list (a legacy pane that never recorded one) may fall
  // back to Settings.
  const requested = explicit ?? normalizeBuiltInMcpDomains(params.defaultDomains)
  return filterBuiltInMcpDomainsForProvider(params.provider, requested)
}

export function normalizeBuiltInMcpOverrides(value: unknown): BuiltInMcpOverrides | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return Object.fromEntries(BUILT_IN_MCP_DOMAINS.flatMap(domain => {
    const choice = (value as Record<string, unknown>)[domain]
    return Object.prototype.hasOwnProperty.call(value, domain) && typeof choice === 'boolean' ? [[domain, choice]] : []
  }))
}

export function sessionMcpOverrides(meta: { builtInMcpDomains?: BuiltInMcpDomain[]; builtInMcpOverrides?: BuiltInMcpOverrides }): BuiltInMcpOverrides {
  // Old persisted lists lost provenance: [] could be a new agent created when
  // defaults were off, or an explicit disable. Migrate enabled capabilities as
  // on and absent capabilities as inherited, so existing agents can finally
  // pick up Settings on reload. New agents always store a map, including {},
  // so later autosaves never mistake inherited enablement for an override.
  return normalizeBuiltInMcpOverrides(meta.builtInMcpOverrides)
    ?? Object.fromEntries(normalizeBuiltInMcpDomains(meta.builtInMcpDomains).map(domain => [domain, true]))
}

export function spawnMcpOverrides(options?: { builtInMcpDomains?: BuiltInMcpDomain[]; builtInMcpOverrides?: BuiltInMcpOverrides }): BuiltInMcpOverrides {
  const overrides = normalizeBuiltInMcpOverrides(options?.builtInMcpOverrides)
  if (overrides !== undefined) return overrides
  if (!Array.isArray(options?.builtInMcpDomains)) return {}
  // Creation APIs accept an explicit complete list, including all-off. Keep
  // that contract for orchestration/control callers; internal continuations
  // pass their preference map separately from the observed capability list.
  return Object.fromEntries(BUILT_IN_MCP_DOMAINS.map(domain => [domain, options.builtInMcpDomains!.includes(domain)]))
}

export function withNormalizedBuiltInMcpDomains<T extends {
  builtInMcpDomains?: BuiltInMcpDomain[]
  builtInMcpOverrides?: BuiltInMcpOverrides
}>(meta: T): T {
  const domains = normalizeSessionBuiltInMcpDomains(meta.builtInMcpDomains)
  if (domains === undefined) {
    const { builtInMcpDomains: _dropped, ...rest } = meta
    return { ...rest, builtInMcpOverrides: sessionMcpOverrides(meta) } as T
  }
  return { ...meta, builtInMcpDomains: domains, builtInMcpOverrides: sessionMcpOverrides(meta) }
}
