import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverClaudeSkillRoots } from '@providers/claude/runtime/skillDiscovery.js'
import { discoverCodexSkillRoots } from '@providers/codex/runtime/skillDiscovery.js'
import { discoverOpencodeSkillRoots } from '@providers/opencode/runtime/skillDiscovery.js'
import { skillProjectDirectories } from './skillDiscovery.js'
import type { AgentSkillDiscoveryContext } from '@shared/types/agentSkills.js'

const temporary: string[] = []
async function context(): Promise<AgentSkillDiscoveryContext> {
  const homeDirectory = await mkdtemp(join(tmpdir(), 'provider-skill-roots-'))
  temporary.push(homeDirectory)
  const cwd = join(homeDirectory, 'project', 'nested')
  await mkdir(cwd, { recursive: true })
  await writeFile(join(homeDirectory, 'project', '.git'), 'gitdir: elsewhere')
  return { cwd, homeDirectory, environment: {}, projectDirectories: await skillProjectDirectories(cwd) }
}
async function json(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(value))
}
afterEach(async () => {
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('provider skill roots', () => {
  it('stops project discovery at a worktree .git file and limits non-project paths to cwd', async () => {
    const ctx = await context()
    expect(ctx.projectDirectories).toEqual([ctx.cwd, dirname(ctx.cwd)])
    expect(await skillProjectDirectories(ctx.homeDirectory)).toEqual([ctx.homeDirectory])
  })
  it('uses the Codex home override for provider defaults without inheriting Claude roots', async () => {
    const ctx = await context()
    ctx.environment = { CODEX_HOME: join(ctx.homeDirectory, 'custom-codex') }
    const discovery = await discoverCodexSkillRoots(ctx)
    expect(discovery.roots).toContainEqual({
      path: join(ctx.homeDirectory, 'custom-codex', 'skills', '.system'),
      source: 'system', sourceLabel: 'Codex defaults',
    })
    expect(discovery.roots.some(root => root.path.includes('.claude'))).toBe(false)
    expect(discovery.roots.filter(root => root.source === 'project')).toHaveLength(2)
  })
  it('includes only enabled Claude plugin installations scoped to this project', async () => {
    const ctx = await context()
    ctx.environment = { CLAUDE_CONFIG_DIR: join(ctx.homeDirectory, 'custom-claude') }
    const claudeHome = ctx.environment.CLAUDE_CONFIG_DIR!
    const enabled = join(ctx.homeDirectory, 'plugin-enabled')
    await json(join(claudeHome, 'settings.json'), { enabledPlugins: { 'review@market': true, 'off@market': false, 'other@market': true } })
    await json(join(claudeHome, 'plugins', 'installed_plugins.json'), {
      version: 2, plugins: {
        'review@market': [{ scope: 'user', installPath: enabled }],
        'off@market': [{ scope: 'user', installPath: join(ctx.homeDirectory, 'off') }],
        'other@market': [{ scope: 'project', projectPath: '/different-project', installPath: '/different-plugin' }],
      },
    })
    await json(join(enabled, '.claude-plugin', 'plugin.json'), { name: 'review', skills: './extra-skills' })
    const discovery = await discoverClaudeSkillRoots(ctx)
    expect(discovery.roots.filter(root => root.source === 'plugin').map(root => root.path)).toEqual([
      join(enabled, 'skills'), join(enabled, 'extra-skills'),
    ])
    expect(discovery.roots).toContainEqual(expect.objectContaining({ path: join(claudeHome, 'skills'), source: 'personal' }))
    expect(discovery.notices).toEqual([expect.stringContaining('bundled skills')])
  })
  it('includes explicitly enabled Codex plugin skills without treating every cached plugin as installed', async () => {
    const ctx = await context()
    const codexHome = join(ctx.homeDirectory, '.codex')
    await mkdir(codexHome, { recursive: true })
    await writeFile(join(codexHome, 'config.toml'), '[plugins."design@market"]\nenabled = true\n[plugins."disabled@market"]\nenabled = false\n')
    const plugin = join(codexHome, 'plugins', 'cache', 'market', 'design', '1.0.0')
    await json(join(plugin, '.codex-plugin', 'plugin.json'), { name: 'design', skills: './skills' })
    await json(join(codexHome, 'plugins', 'cache', 'market', 'disabled', '1.0.0', '.codex-plugin', 'plugin.json'), { name: 'disabled' })
    const discovery = await discoverCodexSkillRoots(ctx)
    expect(discovery.roots.filter(root => root.source === 'plugin')).toEqual([
      expect.objectContaining({ path: join(plugin, 'skills'), sourceLabel: 'design' }),
    ])
  })
  it('respects OpenCode external-skill disabling and its config directory override', async () => {
    const ctx = await context()
    ctx.environment = { OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true', OPENCODE_CONFIG_DIR: join(ctx.homeDirectory, 'custom-opencode') }
    const discovery = await discoverOpencodeSkillRoots(ctx)
    expect(discovery.roots).toContainEqual({
      path: join(ctx.homeDirectory, 'custom-opencode', 'skills'), source: 'personal',
    })
    expect(discovery.roots.some(root => /\.(agents|claude)/.test(root.path))).toBe(false)
  })
})
