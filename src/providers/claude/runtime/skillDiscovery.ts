import { dirname, join, resolve } from 'node:path'
import { asRecord } from '@shared/lib/asRecord.js'
import type { AgentSkillDiscovery, AgentSkillDiscoveryContext } from '@shared/types/agentSkills.js'
import { pluginSkillRoots, readSkillJson } from '@providers/shared/runtime/skillDiscovery.js'

export async function discoverClaudeSkillRoots(context: AgentSkillDiscoveryContext): Promise<AgentSkillDiscovery> {
  const { homeDirectory: home, environment, cwd } = context
  const claudeHome = environment.CLAUDE_CONFIG_DIR || join(home, '.claude')
  const notices = ['Claude bundled skills are supplied by the CLI and are not exposed as installed SKILL.md files.']
  const roots: AgentSkillDiscovery['roots'] = [
    { path: join(claudeHome, 'skills'), source: 'personal' },
    { path: join(claudeHome, 'commands'), source: 'personal', legacyCommands: true },
  ]
  // Claude walks ancestors up to home, unlike Codex/OpenCode's Git-root walk.
  // See vendor/claude-code-src/.../skills/loadSkillsDir.ts and
  // https://code.claude.com/docs/en/skills#choose-where-skills-load .
  const ancestors: string[] = []
  for (let path = resolve(cwd), depth = 0; depth < 128 && path !== home; depth += 1) {
    ancestors.push(path)
    const parent = dirname(path)
    if (parent === path) break
    path = parent
  }
  for (const path of ancestors) {
    roots.push(
      { path: join(path, '.claude', 'skills'), source: 'project' },
      { path: join(path, '.claude', 'commands'), source: 'project', legacyCommands: true },
    )
  }
  const managedHome = process.platform === 'darwin'
    ? '/Library/Application Support/ClaudeCode'
    : process.platform === 'win32' ? 'C:\\Program Files\\ClaudeCode' : '/etc/claude-code'
  roots.push({ path: join(managedHome, '.claude', 'skills'), source: 'system' })
  // Plugin installation and enablement are different sources of truth.
  // Consult the installation registry plus layered settings; never walk the
  // entire cache and accidentally include removed/disabled plugin versions.
  const settingsPaths = [
    join(claudeHome, 'settings.json'),
    ...ancestors.slice().reverse().flatMap(path => [
      join(path, '.claude', 'settings.json'), join(path, '.claude', 'settings.local.json'),
    ]),
    join(managedHome, 'managed-settings.json'),
  ]
  const enabled: Record<string, unknown> = {}
  for (const path of settingsPaths) {
    Object.assign(enabled, asRecord((await readSkillJson(path, notices)).enabledPlugins) ?? {})
  }
  const installed = asRecord((await readSkillJson(join(claudeHome, 'plugins', 'installed_plugins.json'), notices)).plugins) ?? {}
  for (const [id, isEnabled] of Object.entries(enabled)) {
    if (isEnabled !== true) continue
    const records = Array.isArray(installed[id]) ? installed[id] : [installed[id]]
    for (const value of records) {
      const record = asRecord(value)
      if (!record || typeof record.installPath !== 'string') continue
      if (record.scope !== 'user' && record.scope !== 'managed'
        && !ancestors.includes(String(record.projectPath))) continue
      roots.push(...await pluginSkillRoots(record.installPath, id.split('@')[0]!, '.claude-plugin', notices))
    }
  }
  return { roots: roots.map(root => ({ ...root, optionalFrontmatter: true })), notices }
}
