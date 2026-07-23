import {
  filterBuiltInMcpDomainsForProvider,
  normalizeBuiltInMcpDomains,
} from '@mcp/shared/types'
import type { BuiltInMcpDomain } from '@mcp/shared/types'
import type { AgentProviderKind } from '@shared/types/providerKind'

export function normalizeSessionBuiltInMcpDomains(
  value: unknown,
): BuiltInMcpDomain[] | undefined {
  if (!Array.isArray(value)) return undefined
  // WHY an empty array remains an array: once Settings can seed MCP defaults,
  // `undefined` means "this legacy session has no captured choice" while `[]`
  // means "the user explicitly disabled every domain for this session". If we
  // collapse the latter, restoring the pane can silently turn its defaults
  // back on after the user used the session command to turn the last one off.
  return normalizeBuiltInMcpDomains(value)
}

export function resolveSessionBuiltInMcpDomains(params: {
  provider: AgentProviderKind
  sessionDomains: unknown
  defaultDomains: unknown
}): BuiltInMcpDomain[] {
  const explicit = normalizeSessionBuiltInMcpDomains(params.sessionDomains)
  // An explicit list is a complete snapshot, never a partial overlay. Merging
  // defaults here would make a session-level disable impossible whenever the
  // corresponding setting stayed enabled.
  const requested = explicit ?? normalizeBuiltInMcpDomains(params.defaultDomains)
  return filterBuiltInMcpDomainsForProvider(params.provider, requested)
}

export function withNormalizedBuiltInMcpDomains<T extends {
  builtInMcpDomains?: BuiltInMcpDomain[]
}>(meta: T): T {
  const domains = normalizeSessionBuiltInMcpDomains(meta.builtInMcpDomains)
  if (domains === undefined) {
    const { builtInMcpDomains: _dropped, ...rest } = meta
    return rest as T
  }
  return { ...meta, builtInMcpDomains: domains }
}
