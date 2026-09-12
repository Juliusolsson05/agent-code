import { stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { asRecord } from '@shared/lib/asRecord.js'
import type { AgentSkillDiscovery, AgentSkillDiscoveryContext, AgentSkillRoot } from '@shared/types/agentSkills.js'
import {
  findAncestorWithMarker,
  pathInsidePlugin,
  readSkillFile,
  readSkillJson,
} from '@providers/shared/runtime/skillDiscovery.js'

// Source of truth for every rule below is the vendored CLI, not the docs:
// `vendor/claude-code-src/full/skills/loadSkillsDir.ts` (getSkillDirCommands),
// `utils/markdownConfigLoader.ts` (getProjectDirsUpToHome,
// loadMarkdownFilesForSubdir), `utils/plugins/pluginLoader.ts` and
// `utils/plugins/loadPluginCommands.ts`.

// utils/envUtils.ts isEnvTruthy.
function envTruthy(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes(value?.toLowerCase().trim() ?? '')
}

// utils/settings/managedPath.ts getManagedFilePath.
function managedHome(): string {
  if (process.platform === 'darwin') return '/Library/Application Support/ClaudeCode'
  if (process.platform === 'win32') return 'C:\\Program Files\\ClaudeCode'
  return '/etc/claude-code'
}

/**
 * getProjectDirsUpToHome: nearest first, never home itself (user config is
 * loaded separately), and stopping AFTER the git root.
 *
 * WHY the git root matters: the first version walked all the way to home, and
 * both review agents reproduced `~/code/.claude/skills` appearing for an agent
 * in `~/code/app`, plus duplicate project skills from the main checkout for an
 * agent in `app/.worktrees/feat`. Claude stops at the nearest `.git` — file or
 * directory — precisely so a parent folder's skills never leak into a repo.
 * (resolveStopBoundary widens past a nested submodule only when the session
 * root is a different, enclosing repository; Agent Code launches Claude with
 * the pane's cwd as that root, so the nearest `.git` is always the boundary.)
 */
function projectDirectories(cwd: string, home: string, gitRoot: string | null): string[] {
  const directories: string[] = []
  const homeDirectory = resolve(home)
  let current = cwd
  for (let depth = 0; depth < 128; depth += 1) {
    if (current === homeDirectory) break
    directories.push(current)
    if (current === gitRoot) break
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return directories
}

/**
 * The main checkout behind a linked worktree (findCanonicalGitRoot). A worktree
 * `.git` file points at `<main>/.git/worktrees/<name>`, whose `commondir` leads
 * back to `<main>/.git`. Submodules and ordinary checkouts have no such chain
 * and resolve to themselves.
 */
async function canonicalGitRoot(gitRoot: string): Promise<string> {
  try {
    const pointer = await readSkillFile(join(gitRoot, '.git'), 4096)
    const gitDirectory = pointer?.match(/^gitdir:\s*(.+)$/m)?.[1]?.trim()
    if (!gitDirectory) return gitRoot
    const absoluteGitDirectory = resolve(gitRoot, gitDirectory)
    const common = (await readSkillFile(join(absoluteGitDirectory, 'commondir'), 4096))?.trim()
    if (!common) return gitRoot
    const commonDirectory = resolve(absoluteGitDirectory, common)
    return basename(commonDirectory) === '.git' ? dirname(commonDirectory) : gitRoot
  } catch {
    // `.git` is a directory (ordinary checkout) or unreadable: no worktree hop.
    return gitRoot
  }
}

function manifestPaths(value: unknown): string[] {
  return (Array.isArray(value) ? value : [value])
    .filter((item): item is string => typeof item === 'string' && item.length > 0)
}

/**
 * Roots contributed by one enabled plugin installation.
 *
 * pluginLoader.ts only auto-detects `skills/` and `commands/` when the manifest
 * does NOT declare that component (`!manifest.skills ? pathExists(...)`), so an
 * explicit path replaces the default folder; the first version appended it and
 * listed skills the manifest had deliberately excluded. Plugin commands are
 * walked with `stopAtSkillDir: true`, and a skill path may itself be a skill
 * folder (loadSkillsFromDirectory checks `<path>/SKILL.md` first). Command-only
 * plugins previously produced nothing; Claude loads them, so they are listed.
 */
async function pluginRoots(installPath: string, pluginName: string, notices: string[]): Promise<AgentSkillRoot[]> {
  const manifest = await readSkillJson(join(installPath, '.claude-plugin', 'plugin.json'), notices)
  const base = { source: 'plugin' as const, sourceLabel: pluginName, optionalFrontmatter: true }
  const roots: AgentSkillRoot[] = []
  const escaped = () => notices.push(`Ignored a path in the ${pluginName} plugin manifest that points outside the plugin folder.`)

  for (const path of manifest.skills ? manifestPaths(manifest.skills) : ['skills']) {
    const inside = pathInsidePlugin(installPath, path)
    if (inside) roots.push({ ...base, path: inside, layout: 'children', rootMayBeSkill: true })
    else escaped()
  }

  // `commands` is either path(s) or an object mapping of command name to
  // `{ source }` (a Markdown file) or `{ content }` (inline, no file to list).
  const mapping = asRecord(manifest.commands)
  const mappingValues = mapping ? Object.values(mapping).map(asRecord) : []
  const isObjectMapping = mappingValues[0] != null && ('source' in mappingValues[0] || 'content' in mappingValues[0])
  let commandPaths: string[]
  if (isObjectMapping) {
    commandPaths = mappingValues.map(value => value?.source).filter((source): source is string => typeof source === 'string')
    if (mappingValues.some(value => value && typeof value.source !== 'string' && value.content !== undefined)) {
      notices.push(`Inline commands defined in the ${pluginName} plugin manifest have no file and are not listed.`)
    }
  } else {
    commandPaths = manifest.commands ? manifestPaths(manifest.commands) : ['commands']
  }
  for (const path of commandPaths) {
    const inside = pathInsidePlugin(installPath, path)
    if (inside) {
      roots.push({ ...base, path: inside, layout: 'commands', includeHidden: true, stopAtSkillDirectory: true })
    } else {
      escaped()
    }
  }
  return roots
}

export async function discoverClaudeSkillRoots(context: AgentSkillDiscoveryContext): Promise<AgentSkillDiscovery> {
  const { homeDirectory: home, environment } = context
  const cwd = resolve(context.cwd)
  const claudeHome = environment.CLAUDE_CONFIG_DIR || join(home, '.claude')
  const policyHome = managedHome()
  const notices = ['Claude bundled skills are supplied by the CLI and are not exposed as installed SKILL.md files.']
  // Claude skill files may omit frontmatter entirely; the folder names the skill.
  const skillsFolder = (path: string, source: AgentSkillRoot['source']): AgentSkillRoot =>
    ({ path, source, layout: 'children', optionalFrontmatter: true })
  // Legacy commands are found with `rg --files --hidden --follow --glob *.md`.
  const commandsFolder = (path: string, source: AgentSkillRoot['source']): AgentSkillRoot =>
    ({ path, source, layout: 'commands', includeHidden: true, optionalFrontmatter: true })

  const gitRoot = await findAncestorWithMarker(cwd, ['.git'])
  const projects = projectDirectories(cwd, home, gitRoot)

  // Order mirrors Claude's first-wins merge (managed, user, project, legacy
  // commands) so a file reachable from two roots keeps Claude's label.
  const roots: AgentSkillRoot[] = []
  if (!envTruthy(environment.CLAUDE_CODE_DISABLE_POLICY_SKILLS)) {
    roots.push(skillsFolder(join(policyHome, '.claude', 'skills'), 'system'))
  }
  roots.push(skillsFolder(join(claudeHome, 'skills'), 'personal'))
  for (const directory of projects) roots.push(skillsFolder(join(directory, '.claude', 'skills'), 'project'))

  roots.push(commandsFolder(join(policyHome, '.claude', 'commands'), 'system'))
  roots.push(commandsFolder(join(claudeHome, 'commands'), 'personal'))
  for (const directory of projects) roots.push(commandsFolder(join(directory, '.claude', 'commands'), 'project'))
  if (gitRoot) {
    // loadMarkdownFilesForSubdir: inside a linked worktree that has no
    // `.claude/commands` of its own, Claude falls back to the main checkout's.
    // (Skills have no such fallback — only commands.)
    const canonical = await canonicalGitRoot(gitRoot)
    const worktreeHasCommands = await stat(join(gitRoot, '.claude', 'commands')).then(() => true, () => false)
    if (canonical !== gitRoot && !worktreeHasCommands) {
      roots.push(commandsFolder(join(canonical, '.claude', 'commands'), 'project'))
    }
  }

  // Installation (`installed_plugins.json`) and enablement (`enabledPlugins`)
  // are separate sources of truth; the plugin cache holds removed and disabled
  // versions, so it is never walked directly.
  //
  // Settings are layered user < project < local < policy, and project/local
  // settings are read ONLY at the launch directory (settings.ts
  // getSettingsRootPathForSource → getOriginalCwd). Merging every ancestor's
  // settings let an ancestor hide a globally enabled plugin — reproduced in
  // review.
  const enabled: Record<string, unknown> = {}
  for (const file of [
    join(claudeHome, 'settings.json'),
    join(cwd, '.claude', 'settings.json'),
    join(cwd, '.claude', 'settings.local.json'),
    join(policyHome, 'managed-settings.json'),
  ]) {
    Object.assign(enabled, asRecord((await readSkillJson(file, notices)).enabledPlugins) ?? {})
  }
  const installed = asRecord((await readSkillJson(join(claudeHome, 'plugins', 'installed_plugins.json'), notices)).plugins) ?? {}
  for (const [id, isEnabled] of Object.entries(enabled)) {
    if (isEnabled !== true) continue
    const pluginName = id.split('@')[0] || id
    const installations = Array.isArray(installed[id]) ? installed[id] : [installed[id]]
    for (const value of installations) {
      const installation = asRecord(value)
      if (!installation || typeof installation.installPath !== 'string') continue
      // isInstallationRelevantToCurrentProject: user/managed installs apply
      // everywhere; project/local installs only when projectPath IS the launch
      // directory — an ancestor match is not enough.
      const relevant = installation.scope === 'user' || installation.scope === 'managed'
        || (typeof installation.projectPath === 'string' && resolve(installation.projectPath) === cwd)
      if (relevant) roots.push(...await pluginRoots(installation.installPath, pluginName, notices))
    }
  }
  return { roots, notices }
}
