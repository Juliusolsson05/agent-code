export type SettingCategoryId =
  | 'appearance'
  | 'workspace'
  | 'providers'
  | 'agents'
  | 'mcp'
  | 'commands'
  | 'dictation'
  | 'performance'
  | 'experimental'
  | 'safety'
  | 'apps'

export type SettingCategory = {
  id: SettingCategoryId
  label: string
  description: string
}

export const SETTING_CATEGORIES: SettingCategory[] = [
  {
    id: 'appearance',
    label: 'Appearance',
    description: 'Theme modes, accents, and contrast.',
  },
  {
    id: 'workspace',
    label: 'Workspace',
    description: 'How the shell behaves during normal use.',
  },
  {
    id: 'providers',
    label: 'Providers',
    description: 'Which coding agents appear in Agent Code, and what usage they report.',
  },
  {
    id: 'agents',
    label: 'Agents',
    description: 'Shared behavior and instructions for agent runtimes.',
  },
  // Its own category (#1143) because MCP is now one grid of built-in and user
  // servers per provider plus the external operator server — three rows that
  // used to be spread through Agents as eight separate toggles.
  {
    id: 'mcp',
    label: 'MCP',
    description: 'Tools your agents can use: Agent Code\'s own MCP servers and yours.',
  },
  {
    id: 'commands',
    label: 'Commands',
    description: 'Keyboard shortcuts and what appears in the command palette.',
  },
  {
    id: 'dictation',
    label: 'Dictation',
    description: 'Inline speech-to-text for the active composer.',
  },
  { id: 'performance', label: 'Performance', description: 'Live health, resource use and local slowdown evidence.' },
  {
    id: 'experimental',
    label: 'Experimental',
    description: 'Features that still depend on local setup.',
  },
  {
    id: 'safety',
    label: 'Safety',
    description: 'Defaults that change agent risk posture.',
  },
  // Last on purpose: apps are additive tooling rather than a setting that changes
  // how the shell or an agent behaves, so they should not push the behavioural
  // categories down the list. In Stage 2 this becomes the install/manage surface
  // and the position can be revisited then, with a reason.
  {
    id: 'apps',
    label: 'Extensions',
    description: 'Install extensions from a GitHub repository.',
  },
]
