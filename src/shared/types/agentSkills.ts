import type { AgentProviderKind } from './providerKind.js'

export type AgentSkillSource = 'agent-code' | 'personal' | 'project' | 'system' | 'plugin'

// This is installation evidence, deliberately separate from session runtime
// state. A file can be installed while an older running CLI has not discovered
// it, or while provider policy prevents invocation. Never use this inventory
// to decide which tools/skills a model may execute.
export type InstalledAgentSkill = {
  name: string
  description: string
  path: string
  source: AgentSkillSource
  sourceLabel?: string
}

export type AgentSkillsRequest = { provider: AgentProviderKind; cwd: string }
export type AgentSkillsSnapshot = {
  skills: InstalledAgentSkill[]
  notices: string[]
}

export type AgentSkillRoot = {
  path: string
  source: Exclude<AgentSkillSource, 'agent-code'>
  sourceLabel?: string
  /** Claude still accepts standalone Markdown commands as skills. */
  legacyCommands?: boolean
  /** Claude permits omitted name/description/frontmatter; other providers do not. */
  optionalFrontmatter?: boolean
}

export type AgentSkillDiscoveryContext = {
  cwd: string
  homeDirectory: string
  environment: Readonly<Record<string, string | undefined>>
  /** Nearest directory first, ending at the Git worktree root. */
  projectDirectories: string[]
}

export type AgentSkillDiscovery = { roots: AgentSkillRoot[]; notices: string[] }

// Only the managed-skills service can attribute a deployment to Agent Code.
// Names and public marker comments are not ownership proof, and consumers must
// not infer it by parsing conventions.json or writing into provider roots.
export type ManagedAgentSkillLocations = { paths: string[]; notices: string[] }
