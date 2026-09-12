import type { AgentProviderKind } from '@shared/types/providerKind.js'

export type BuiltInMcpDomain =
  | 'tldr'
  | 'ping'
  | 'orchestration'
  | 'ai_workspace'
  | 'agent_transcripts'
  | 'agent_management'
  | 'root_management'
  | 'workflows'

export const BUILT_IN_MCP_DOMAINS = [
  'tldr',
  'ping',
  'orchestration',
  'ai_workspace',
  'agent_transcripts',
  'agent_management',
  'root_management',
  'workflows',
] as const satisfies readonly BuiltInMcpDomain[]

/**
 * Product capabilities a user may enable globally for new/reloaded agents.
 *
 * WHY `ping` is not merely hidden by the Settings UI: persisted Settings are
 * untrusted, long-lived input and can survive downgrades, hand edits, and
 * experimental builds. Giving configurable defaults their own closed list
 * prevents a stale `ping` value from turning a diagnostic bridge probe into a
 * normal model-visible capability on every new session.
 *
 * WHY `root_management` is also absent (#906): it hands one agent the external
 * operator's application-wide control catalog, every window, project, agent,
 * terminal and layout. That is only ever right for one supervised agent in one
 * rare moment, which is why the session command gates it behind a confirmation
 * dialog. A defaults row would let a single click, or a stale persisted list,
 * grant it to every new agent silently. Keeping it out of this closed list is
 * what makes "never on by default" a property of the code rather than of the
 * Settings UI's current shape.
 */
export const CONFIGURABLE_BUILT_IN_MCP_DOMAINS = [
  'tldr',
  'orchestration',
  'ai_workspace',
  'agent_transcripts',
  'agent_management',
  'workflows',
] as const satisfies readonly BuiltInMcpDomain[]

export type ConfigurableBuiltInMcpDomain =
  (typeof CONFIGURABLE_BUILT_IN_MCP_DOMAINS)[number]

/** Absence inherits Settings. A false value is an intentional per-agent off,
 * not an old effective snapshot captured before a global setting changed. */
export type BuiltInMcpOverrides = Partial<Record<BuiltInMcpDomain, boolean>>

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
 * available there. OpenCode accepts the same HTTP endpoints through its
 * process-local inline configuration; both its structured server runtime and
 * native terminal runtime inject that configuration at launch.
 *
 * `root_management` is provider-agnostic: it projects the control catalog that
 * the external operator server already serves, and every launcher that can
 * carry a built-in MCP config can carry it. The per-agent confirmation gate,
 * not the provider, is what keeps it rare.
 */
const BUILT_IN_MCP_DOMAINS_BY_PROVIDER = {
  claude: [
    'tldr',
    'ping',
    'orchestration',
    'ai_workspace',
    'agent_transcripts',
    'agent_management',
    'root_management',
  ],
  codex: [...BUILT_IN_MCP_DOMAINS],
  opencode: [...BUILT_IN_MCP_DOMAINS],
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
  tldrIdentity?: string
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
