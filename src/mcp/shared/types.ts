export type BuiltInMcpDomain =
  | 'ping'
  | 'orchestration'
  | 'ai_workspace'
  | 'agent_transcripts'
  | 'workflows'

export const BUILT_IN_MCP_DOMAINS: readonly BuiltInMcpDomain[] = [
  'ping',
  'orchestration',
  'ai_workspace',
  'agent_transcripts',
  'workflows',
] as const

export type BuiltInMcpServerConfig = {
  name: string
  url: string
  /**
   * Kept separate from ordinary headers so provider launchers can choose a protected transport.
   * Putting this value in `headers` previously made both the Codex `--config` override and
   * Claude's inline `--mcp-config` JSON publish the bearer in the OS process argument list.
   */
  bearerToken?: string
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
