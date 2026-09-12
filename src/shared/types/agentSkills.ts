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
  /**
   * Present on disk but switched off by provider configuration that applies to
   * Agent Code's sessions (Codex `[[skills.config]]`, plus the external-operator
   * skill Agent Code disables for every Codex session it launches). Listing it
   * as disabled rather than hiding it keeps "why isn't my skill used?" answerable
   * from the panel.
   */
  disabled?: boolean
}

export type AgentSkillsRequest = { provider: AgentProviderKind; cwd: string }
export type AgentSkillsSnapshot = {
  skills: InstalledAgentSkill[]
  notices: string[]
}

/**
 * How skill files are arranged below a root.
 *
 * WHY this is per-root data instead of one generic walk: the first version of
 * PR #903 used a single depth-12 "stop at the first SKILL.md" walk for every
 * provider, and both review agents showed it matched none of them. Claude
 * fabricated a skill from a stray `skills/SKILL.md` and listed nested
 * `skills/archive/old/SKILL.md` it never loads; Codex skills nested inside
 * other skills were missed. Each adapter now states its provider's real rule.
 *
 * - `children`: Claude `skills/` folders and Codex agent plugins — only
 *   `<root>/<name>/SKILL.md` (`vendor/claude-code-src/full/skills/loadSkillsDir.ts`
 *   loadSkillsFromSkillsDir; Codex `SkillDiscoveryMode::DirectChildren`). Claude
 *   plugin skill paths additionally accept `<root>/SKILL.md` via `rootMayBeSkill`.
 * - `recursive`: Codex and OpenCode — every `SKILL.md` below the root up to
 *   `maxDepth`, including skills nested inside another skill's folder.
 * - `commands`: Claude legacy/plugin commands — every `*.md`, recursively; a
 *   directory that holds `SKILL.md` contributes only that file.
 */
export type AgentSkillLayout = 'children' | 'recursive' | 'commands'

export type AgentSkillRoot = {
  /** A directory, or (for `commands`) a single Markdown command file. */
  path: string
  source: Exclude<AgentSkillSource, 'agent-code'>
  sourceLabel?: string
  layout: AgentSkillLayout
  /** `children` only: the root itself may be a skill folder. */
  rootMayBeSkill?: boolean
  /**
   * `recursive` only: deepest allowed `SKILL.md`, counted in path segments below
   * the root (`<root>/SKILL.md` is 1). Mirrors Codex's walk `max_depth`. When
   * omitted the collector's own safety ceiling applies and hitting it is reported.
   */
  maxDepth?: number
  /** Descend into (or, for `children`, accept) dot-directories below the root. */
  includeHidden?: boolean
  /**
   * Treat linked folders below the root as folders (default true). Codex
   * ignores directory symlinks under its System scope
   * (`ext/skills/src/loader/host.rs` DirectorySymlinkPolicy::Ignore).
   */
  followDirectorySymlinks?: boolean
  /** `commands` only: a directory holding `SKILL.md` is a leaf; do not descend. */
  stopAtSkillDirectory?: boolean
  /** Claude permits omitted name/description/frontmatter; other providers do not. */
  optionalFrontmatter?: boolean
  /**
   * Codex exposes a plugin's skills as `<plugin>:<name>` and applies
   * `[[skills.config]]` name rules to that qualified name
   * (`ext/skills/src/loader/namespace.rs` qualify). When set, both the listed
   * name and name-rule matching use the qualified form; matching the bare
   * frontmatter name missed `sample:review` rules and let an unqualified rule
   * wrongly disable plugin skills.
   */
  namespace?: string
}

/**
 * One ordered enablement rule. Later rules override earlier ones for the skills
 * they match, exactly like Codex `SkillConfigRules::resolve_disabled_paths`.
 * Path rules name the skill's `SKILL.md`; name rules match (qualified) names.
 */
export type AgentSkillEnablementRule =
  | { path: string; enabled: boolean }
  | { name: string; enabled: boolean }

export type AgentSkillDiscoveryContext = {
  /** The agent's launch directory. Each adapter derives its own ancestry from
   *  it — Claude, Codex and OpenCode stop at different boundaries, and a shared
   *  precomputed list is what let Claude discovery cross the repository root. */
  cwd: string
  homeDirectory: string
  environment: Readonly<Record<string, string | undefined>>
}

export type AgentSkillDiscovery = {
  roots: AgentSkillRoot[]
  notices: string[]
  enablementRules?: AgentSkillEnablementRule[]
}

// Only the managed-skills service can attribute a deployment to Agent Code.
// Names and public marker comments are not ownership proof, and consumers must
// not infer it by parsing conventions.json or writing into provider roots.
export type ManagedAgentSkillLocations = { paths: string[]; notices: string[] }
