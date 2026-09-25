import type { ConfigurableBuiltInMcpDomain } from '@mcp/shared/types'

/**
 * Display metadata for Agent Code's own MCP capabilities in the MCP grid and
 * the per-agent picker (#1143). The copy is carried over from the eight
 * Settings rows and ten palette commands this interface replaced, so users
 * who knew those descriptions find the same words.
 *
 * Order is the grid's row order: the everyday peeks first, then coordination,
 * then the opt-in tools.
 */
export const BUILT_IN_MCP_SERVERS: readonly {
  domain: ConfigurableBuiltInMcpDomain
  title: string
  description: string
}[] = [
  { domain: 'tldr', title: 'TLDR', description: 'Concise status summaries; hold Cmd+L to read them.' },
  { domain: 'goal', title: 'Goal', description: 'What each agent\'s work is for; hold Cmd+G to see it. Agents mark it complete once you accept the work.' },
  { domain: 'auto_title', title: 'Auto Title', description: 'Let agents keep a short current-job title. Manual titles and clears take priority; changes apply on the next reload.' },
  { domain: 'goal_loop', title: 'Goal Loop', description: 'Harness-owned loops that re-prompt until the goal is done.' },
  { domain: 'orchestration', title: 'Orchestration', description: 'Create and coordinate child agents.' },
  { domain: 'agent_transcripts', title: 'Agent Transcripts', description: 'Bounded transcript file tools.' },
  { domain: 'agent_management', title: 'Agent Management', description: 'Inspect project agents and send follow-ups.' },
  { domain: 'ai_workspace', title: 'AI Workspace', description: 'Curate review workspaces across worktrees.' },
  { domain: 'workflows', title: 'Workflows', description: 'Durable workflow tools. Claude has workflows natively.' },
  // #1142: the agent's own browser pocket. The tools answer "disabled" until
  // Settings → Experimental → Browser Pocket is on.
  { domain: 'browser', title: 'Browser Pocket', description: 'Open, read and click the agent\'s own browser pocket (needs Browser Pocket on in Experimental).' },
  // #1143: last because it manages the list this grid shows.
  { domain: 'mcp_servers', title: 'MCP Servers', description: 'Let the agent add, change and remove your MCP servers.' },
  // #1161: proposals only — they land switched off until the user reviews
  // them in Settings → Skills.
  { domain: 'skills', title: 'Skills', description: 'Let the agent find skills and propose them for your review in Settings → Skills.' },
]
