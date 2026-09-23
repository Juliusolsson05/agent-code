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
  { domain: 'goal', title: 'Goal', description: 'What each agent\'s work is for; hold Cmd+G to see it.' },
  { domain: 'goal_loop', title: 'Goal Loop', description: 'Harness-owned loops that re-prompt until the goal is done.' },
  { domain: 'orchestration', title: 'Orchestration', description: 'Create and coordinate child agents.' },
  { domain: 'agent_transcripts', title: 'Agent Transcripts', description: 'Bounded transcript file tools.' },
  { domain: 'agent_management', title: 'Agent Management', description: 'Inspect project agents and send follow-ups.' },
  { domain: 'ai_workspace', title: 'AI Workspace', description: 'Curate review workspaces across worktrees.' },
  { domain: 'workflows', title: 'Workflows', description: 'Durable workflow tools. Claude has workflows natively.' },
]
