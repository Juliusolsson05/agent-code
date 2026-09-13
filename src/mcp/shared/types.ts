import type { AgentProviderKind } from '@shared/types/providerKind.js'

export type BuiltInMcpDomain =
  | 'tldr'
  | 'goal'
  | 'ping'
  | 'orchestration'
  | 'ai_workspace'
  | 'agent_transcripts'
  | 'agent_management'
  | 'root_management'
  | 'workflows'

export const BUILT_IN_MCP_DOMAINS = [
  'tldr',
  'goal',
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
  'goal',
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
 * Capabilities a NEW agent may never inherit from an existing one, however that
 * new agent is created.
 *
 * WHY this list exists separately from the configurable-defaults list: keeping
 * `root_management` out of Settings stops it being switched on for a whole
 * fleet, but says nothing about copying it from one agent to another. Duplicate
 * Agent and the control surface's native copy both carry the source pane's
 * capability choices to the clone on purpose — that is what makes a duplicate a
 * duplicate — and application-wide control is the one capability where that is
 * wrong: the grant is gated behind a confirmation dialog naming the agent it
 * applies to, so a second agent holding it was never confirmed by anyone. It
 * also closes an escalation: the granting agent's own catalog includes
 * `agents.duplicate`, so without this rule one confirmed grant could be
 * replicated by the agent itself, repeatedly.
 */
export const CONFIRMATION_GATED_BUILT_IN_MCP_DOMAINS = [
  'root_management',
] as const satisfies readonly BuiltInMcpDomain[]

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
    'goal',
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
  /**
   * Present only on a TLDR-enabled registration's own launch config. Provider launchers inject
   * turn hooks that post to `${baseUrl}/<event>` with this same bearer, so a hook can only ever
   * read or change its own session's reporting state and is revoked with it.
   *
   * WHY it is absent from `sessionServers()`: workflow subagents reuse the parent's token, and
   * enforcing the parent's TLDR on each subagent's turns would block work that owns no summary.
   */
  tldrHooks?: { baseUrl: string }
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
