export type BuiltInMcpDomain = 'ping' | 'orchestration'

export const BUILT_IN_MCP_DOMAINS: readonly BuiltInMcpDomain[] = [
  'ping',
  'orchestration',
] as const

export type BuiltInMcpServerConfig = {
  name: string
  url: string
  headers: Record<string, string>
}

export type McpSessionScope = {
  sessionId: string
  cwd: string
  domains: BuiltInMcpDomain[]
}

export function normalizeBuiltInMcpDomains(
  value: readonly BuiltInMcpDomain[] | undefined,
): BuiltInMcpDomain[] {
  if (!value || value.length === 0) return []
  const allowed = new Set(BUILT_IN_MCP_DOMAINS)
  const seen = new Set<BuiltInMcpDomain>()
  const normalized: BuiltInMcpDomain[] = []
  for (const domain of value) {
    if (!allowed.has(domain)) continue
    if (seen.has(domain)) continue
    seen.add(domain)
    normalized.push(domain)
  }
  return normalized
}
