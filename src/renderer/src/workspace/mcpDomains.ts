import {
  BUILT_IN_MCP_DOMAINS,
  type BuiltInMcpDomain,
} from '@mcp/shared/types'

const BUILT_IN_MCP_DOMAIN_SET = new Set<string>(BUILT_IN_MCP_DOMAINS)

export function normalizeSessionBuiltInMcpDomains(
  value: unknown,
): BuiltInMcpDomain[] | undefined {
  if (!Array.isArray(value)) return undefined
  const seen = new Set<BuiltInMcpDomain>()
  const normalized: BuiltInMcpDomain[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    if (!BUILT_IN_MCP_DOMAIN_SET.has(item)) continue
    const domain = item as BuiltInMcpDomain
    if (seen.has(domain)) continue
    seen.add(domain)
    normalized.push(domain)
  }
  return normalized.length > 0 ? normalized : undefined
}

export function withNormalizedBuiltInMcpDomains<T extends {
  builtInMcpDomains?: BuiltInMcpDomain[]
}>(meta: T): T {
  const domains = normalizeSessionBuiltInMcpDomains(meta.builtInMcpDomains)
  if (!domains) {
    const { builtInMcpDomains: _dropped, ...rest } = meta
    return rest as T
  }
  return { ...meta, builtInMcpDomains: domains }
}
