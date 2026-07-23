import type { AgentProviderKind } from '@shared/types/providerKind.js'

export type BuiltInMcpDomain =
  | 'ping'
  | 'orchestration'
  | 'ai_workspace'
  | 'agent_transcripts'
  | 'agent_management'
  | 'workflows'

export const BUILT_IN_MCP_DOMAINS = [
  'ping',
  'orchestration',
  'ai_workspace',
  'agent_transcripts',
  'agent_management',
  'workflows',
] as const satisfies readonly BuiltInMcpDomain[]

/**
 * Product capabilities a user may enable by default for new agent sessions.
 *
 * WHY `ping` is not merely hidden by the Settings UI: persisted Settings are
 * untrusted, long-lived input and can survive downgrades, hand edits, and
 * experimental builds. Giving configurable defaults their own closed list
 * prevents a stale `ping` value from turning a diagnostic bridge probe into a
 * normal model-visible capability on every new session.
 */
export const CONFIGURABLE_BUILT_IN_MCP_DOMAINS = [
  'orchestration',
  'ai_workspace',
  'agent_transcripts',
  'agent_management',
  'workflows',
] as const satisfies readonly BuiltInMcpDomain[]

export type ConfigurableBuiltInMcpDomain =
  (typeof CONFIGURABLE_BUILT_IN_MCP_DOMAINS)[number]

/**
 * The provider launchers, not the generic "agent provider" type, determine
 * whether an MCP configuration reaches the model. Keep that decision
 * exhaustive here so registering a future provider creates an explicit MCP
 * policy task instead of silently inheriting every built-in tool.
 *
 * WHY Workflow MCP is absent from Claude: it emulates the workflow facility
 * Claude already provides natively. Advertising both gives the model two
 * overlapping control planes with different persistence and execution rules.
 * Codex has no equivalent native surface, so Agent Code's Workflow MCP remains
 * available there. OpenCode's current runtime does not consume
 * `builtInMcpServers` at all; claiming support before its launcher injects the
 * configuration would create toggles that appear to work while exposing no
 * tools to the model.
 */
const BUILT_IN_MCP_DOMAINS_BY_PROVIDER = {
  claude: [
    'ping',
    'orchestration',
    'ai_workspace',
    'agent_transcripts',
    'agent_management',
  ],
  codex: [...BUILT_IN_MCP_DOMAINS],
  opencode: [],
} as const satisfies Record<AgentProviderKind, readonly BuiltInMcpDomain[]>

const BUILT_IN_MCP_DOMAIN_SET = new Set<string>(BUILT_IN_MCP_DOMAINS)
const CONFIGURABLE_BUILT_IN_MCP_DOMAIN_SET = new Set<string>(
  CONFIGURABLE_BUILT_IN_MCP_DOMAINS,
)

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
  value: unknown,
): BuiltInMcpDomain[] {
  if (!Array.isArray(value) || value.length === 0) return []
  const seen = new Set<BuiltInMcpDomain>()
  const normalized: BuiltInMcpDomain[] = []
  for (const domain of value) {
    if (typeof domain !== 'string' || !BUILT_IN_MCP_DOMAIN_SET.has(domain)) continue
    const accepted = domain as BuiltInMcpDomain
    if (seen.has(accepted)) continue
    seen.add(accepted)
    normalized.push(accepted)
  }
  return normalized
}

export function normalizeConfigurableBuiltInMcpDomains(
  value: unknown,
): ConfigurableBuiltInMcpDomain[] {
  if (!Array.isArray(value) || value.length === 0) return []
  const seen = new Set<ConfigurableBuiltInMcpDomain>()
  const normalized: ConfigurableBuiltInMcpDomain[] = []
  for (const domain of value) {
    if (
      typeof domain !== 'string' ||
      !CONFIGURABLE_BUILT_IN_MCP_DOMAIN_SET.has(domain)
    ) {
      continue
    }
    const accepted = domain as ConfigurableBuiltInMcpDomain
    if (seen.has(accepted)) continue
    seen.add(accepted)
    normalized.push(accepted)
  }
  return normalized
}

export function providerSupportsBuiltInMcpDomain(
  provider: AgentProviderKind,
  domain: BuiltInMcpDomain,
): boolean {
  return (BUILT_IN_MCP_DOMAINS_BY_PROVIDER[provider] as readonly BuiltInMcpDomain[])
    .includes(domain)
}

export function filterBuiltInMcpDomainsForProvider(
  provider: AgentProviderKind,
  value: unknown,
): BuiltInMcpDomain[] {
  return normalizeBuiltInMcpDomains(value)
    .filter(domain => providerSupportsBuiltInMcpDomain(provider, domain))
}
