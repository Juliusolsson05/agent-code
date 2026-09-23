import type { FeatureReference } from '@control-sdk'

// Keep purpose, UI routes and limitations beside this feature (#1143). The
// assembled control reference adds current commands/bindings itself.
export const controlReference = [
  {
    id: 'mcp',
    title: 'MCP servers',
    purpose:
      'Choose which MCP servers agents get: Agent Code\'s built-in servers and user-added servers (stdio, HTTP or SSE), per provider and per agent.',
    ui: 'Settings → MCP (one grid, a column per enabled provider), Add MCP Server… (paste a README config), and Agent MCP Servers… (the focused agent, applied with one reload).',
    prerequisites: 'None for built-in servers. A user server needs whatever its README describes, for example Beeper Desktop running with its MCP server enabled.',
    workflow: [
      'Add a server by pasting its mcpServers or VS Code snippet; values from env and headers become encrypted secrets',
      'Tick the provider columns whose new agents should get it, or switch it off everywhere with its master switch',
      'Use Agent MCP Servers… to add or remove servers for one agent; it reloads that agent once and resumes the same conversation',
    ],
    outcome: 'New agents, and existing agents on their next reload, launch with the chosen servers. Agent Code never writes the CLIs\' own config files.',
    cautions:
      'User servers reach Claude and Codex only; OpenCode and Grok get built-in servers only. Codex cannot use SSE servers, and a user server whose name is already in the user\'s Codex config.toml is skipped for Codex. A server that cannot attach (missing secret, invalid config, enterprise Claude MCP policy) is left out of that launch with a notice; the agent still starts. Secrets are passed to the MCP server through the agent process environment, so the agent\'s own tools can read them. Changes need an agent reload. OAuth servers sign in through each CLI (codex mcp login, Claude /mcp).',
    commandIds: ['mcp-servers', 'add-mcp-server', 'agent-mcp-servers'],
  },
] satisfies FeatureReference[]
