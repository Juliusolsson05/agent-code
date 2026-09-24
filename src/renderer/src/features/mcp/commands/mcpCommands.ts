import type { CommandDef } from '@renderer/features/command-palette/types'
import { commandTargetSessionId } from '@renderer/workspace/hook/selectors/commandTargetSessionId'
import { DEFAULT_PROVIDER, isAgentProviderKind } from '@shared/types/providerKind'

/**
 * MCP server commands (#1143).
 *
 * WHY three commands and not one per server: the catalog is context-free (it
 * cannot read stores at module scope; see catalog.ts), so it cannot generate a
 * command per user-configured server. The per-agent picker and the Settings
 * grid list the servers instead. These three replace the ten per-capability
 * `Enable … MCP` toggles and `Use Global MCP Settings`, which each reloaded the
 * agent on their own; see RETIRED_BUILT_IN_COMMAND_IDS.
 */
export const mcpCommands: CommandDef[] = [
  {
    id: 'mcp-servers',
    category: 'preferences',
    surface: 'app',
    title: 'MCP Servers',
    description:
      '**What it does:** Opens **Settings → MCP**: Agent Code\'s own MCP servers and yours, with one column per provider.\n\n**Use when:** You want to add a server, turn one on or off everywhere, or choose which providers new agents get it on.\n\n**Notes:** Changes apply to new agents and to existing agents when they reload. Use **Agent MCP Servers…** for one agent.',
    keywords: ['mcp', 'server', 'servers', 'tools', 'settings', 'beeper', 'install', 'enable', 'disable', 'tldr', 'goal', 'orchestration'],
    run: ({ ui }) => {
      ui.openSettings('mcp')
    },
  },
  {
    id: 'add-mcp-server',
    category: 'preferences',
    surface: 'app',
    title: 'Add MCP Server…',
    description:
      '**What it does:** Adds an MCP server by pasting the config from its README.\n\n**Use when:** A server documents a Claude Code, Cursor, VS Code or generic `mcpServers` snippet — for example Beeper Desktop.\n\n**Notes:** Tokens in the snippet are stored as encrypted secrets, never in a config file.',
    keywords: ['mcp', 'server', 'add', 'install', 'new', 'paste', 'config', 'beeper', 'stdio', 'http'],
    run: ({ ui }) => {
      ui.openMcpServerDialog()
    },
  },
  {
    id: 'agent-mcp-servers',
    category: 'session',
    surface: 'session',
    title: 'Agent MCP Servers…',
    description:
      '**What it does:** Chooses which MCP servers the focused **agent** has — Agent Code\'s own and yours — then reloads it once.\n\n**Use when:** One agent should have a server the others do not, or should not have one they do.\n\n**Notes:** Resumes the same conversation. Reset returns the agent to Settings → MCP. Root Management still asks for confirmation.',
    keywords: [
      'mcp', 'server', 'servers', 'tools', 'agent', 'enable', 'disable', 'toggle', 'reload', 'override',
      'global', 'reset', 'tldr', 'goal', 'loop', 'orchestration', 'ai workspace', 'transcripts',
      'agent management', 'workflow', 'root',
    ],
    when: ({ workspace }) => {
      const id = commandTargetSessionId(workspace)
      const meta = id ? workspace.state.sessions[id] : null
      return Boolean(meta && isAgentProviderKind(meta.kind ?? DEFAULT_PROVIDER))
    },
    run: ({ workspace, ui }) => {
      // Captured now, not when the user presses Apply: Dispatch focus can move
      // while the picker is open, and the reload must land on this agent.
      const id = commandTargetSessionId(workspace)
      const meta = id ? workspace.state.sessions[id] : null
      if (!id || !meta || !isAgentProviderKind(meta.kind ?? DEFAULT_PROVIDER)) return
      ui.closePalette()
      ui.openAgentMcpServers(id)
    },
  },
]
