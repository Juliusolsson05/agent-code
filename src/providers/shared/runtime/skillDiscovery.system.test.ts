import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverClaudeSkillRoots } from '@providers/claude/runtime/skillDiscovery.js'
import { compareCodexPluginVersions, discoverCodexSkillRoots } from '@providers/codex/runtime/skillDiscovery.js'
import { discoverOpencodeSkillRoots } from '@providers/opencode/runtime/skillDiscovery.js'
import { collectInstalledAgentSkills } from '@main/agentSkills/inventory.js'
import type { AgentSkillDiscovery, AgentSkillDiscoveryContext, AgentSkillRoot } from '@shared/types/agentSkills.js'

// Each regression below reproduces a finding from the PR #903 Claude/Codex
// reviews against the vendored provider source; the test names say which rule.

const temporary: string[] = []
async function home(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'provider-skill-roots-'))
  temporary.push(path)
  return path
}
async function write(path: string, body: string) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, body)
}
const json = (path: string, value: unknown) => write(path, JSON.stringify(value))
const context = (homeDirectory: string, cwd: string, environment: Record<string, string> = {}): AgentSkillDiscoveryContext =>
  ({ homeDirectory, cwd, environment })
const paths = (discovery: AgentSkillDiscovery, predicate: (root: AgentSkillRoot) => boolean) =>
  discovery.roots.filter(predicate).map(root => root.path)
const skill = (name: string) => `---\nname: ${name}\ndescription: ${name} description\n---\n`
const AGENT_PLUGIN_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'
afterEach(async () => {
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('Claude skill roots', () => {
  it('stops project discovery after the git root and never treats home as a project', async () => {
    const base = await home()
    const app = join(base, 'code', 'app')
    await mkdir(join(app, '.git'), { recursive: true })
    await mkdir(join(app, 'pkg'), { recursive: true })
    const inRepo = await discoverClaudeSkillRoots(context(base, join(app, 'pkg')))
    expect(paths(inRepo, root => root.source === 'project' && root.layout === 'children')).toEqual([
      join(app, 'pkg', '.claude', 'skills'),
      join(app, '.claude', 'skills'),
    ])
    const loose = join(base, 'loose', 'dir')
    await mkdir(loose, { recursive: true })
    const outsideGit = await discoverClaudeSkillRoots(context(base, loose))
    expect(paths(outsideGit, root => root.source === 'project' && root.layout === 'children')).toEqual([
      join(loose, '.claude', 'skills'),
      join(base, 'loose', '.claude', 'skills'),
    ])
  })

  it('falls back to the main checkout commands only from a validated linked worktree, and never for skills', async () => {
    const base = await home()
    const main = join(base, 'code', 'app')
    const worktreeGitDirectory = join(main, '.git', 'worktrees', 'feat')
    const worktree = join(main, '.worktrees', 'feat')
    await write(join(worktreeGitDirectory, 'commondir'), '../..\n')
    await write(join(worktree, '.git'), 'gitdir: ../../.git/worktrees/feat\n')
    // `git worktree add` writes the realpath back-link; Claude requires it.
    await write(join(worktreeGitDirectory, 'gitdir'), `${join(await realpath(worktree), '.git')}\n`)
    const discovery = await discoverClaudeSkillRoots(context(base, worktree))
    expect(paths(discovery, root => root.source === 'project' && root.layout === 'children')).toEqual([
      join(worktree, '.claude', 'skills'),
    ])
    expect(paths(discovery, root => root.source === 'project' && root.layout === 'commands')).toEqual([
      join(worktree, '.claude', 'commands'),
      join(main, '.claude', 'commands'),
    ])
    await mkdir(join(worktree, '.claude', 'commands'), { recursive: true })
    const own = await discoverClaudeSkillRoots(context(base, worktree))
    expect(paths(own, root => root.source === 'project' && root.layout === 'commands')).toEqual([
      join(worktree, '.claude', 'commands'),
    ])

    // Round-two regression: a cloned repository's forged `.git` file and
    // `commondir` must not pull another repository's commands in.
    const rogue = join(base, 'rogue')
    await write(join(rogue, '.git'), 'gitdir: ./fake\n')
    await write(join(rogue, 'fake', 'commondir'), `${join(main, '.git')}\n`)
    const forged = await discoverClaudeSkillRoots(context(base, rogue))
    expect(paths(forged, root => root.source === 'project' && root.layout === 'commands')).toEqual([
      join(rogue, '.claude', 'commands'),
    ])
  })

  it('reads plugin enablement only from launch-directory settings and requires exact project installs', async () => {
    const base = await home()
    const repo = join(base, 'repo')
    const cwd = join(repo, 'packages', 'web')
    await mkdir(join(repo, '.git'), { recursive: true })
    await mkdir(cwd, { recursive: true })
    const claudeHome = join(base, '.claude')
    const plugin = (name: string) => join(base, 'plugins', name)
    await json(join(claudeHome, 'settings.json'), { enabledPlugins: { 'global@m': true, 'here@m': true, 'ancestor@m': true } })
    // An ancestor's settings are not Claude's project settings for this agent.
    await json(join(repo, '.claude', 'settings.json'), { enabledPlugins: { 'global@m': false } })
    await json(join(claudeHome, 'plugins', 'installed_plugins.json'), {
      version: 2,
      plugins: {
        'global@m': [{ scope: 'user', installPath: plugin('global') }],
        'here@m': [{ scope: 'project', projectPath: cwd, installPath: plugin('here') }],
        'ancestor@m': [{ scope: 'project', projectPath: repo, installPath: plugin('ancestor') }],
      },
    })
    const discovery = await discoverClaudeSkillRoots(context(base, cwd))
    expect([...new Set(discovery.roots.filter(root => root.source === 'plugin').map(root => root.sourceLabel))])
      .toEqual(['global', 'here'])
  })

  it('lets manifest paths replace default plugin folders, lists command-only plugins, and refuses escaping paths', async () => {
    const base = await home()
    const cwd = join(base, 'work')
    await mkdir(cwd, { recursive: true })
    const claudeHome = join(base, '.claude')
    const selective = join(base, 'plugins', 'selective')
    const commandOnly = join(base, 'plugins', 'command-only')
    await json(join(claudeHome, 'settings.json'), { enabledPlugins: { 'selective@m': true, 'command-only@m': true } })
    await json(join(claudeHome, 'plugins', 'installed_plugins.json'), {
      plugins: {
        'selective@m': [{ scope: 'user', installPath: selective }],
        'command-only@m': [{ scope: 'user', installPath: commandOnly }],
      },
    })
    await json(join(selective, '.claude-plugin', 'plugin.json'), { name: 'selective', skills: ['./selected', '../../outside'] })
    await write(join(selective, 'skills', 'excluded', 'SKILL.md'), skill('excluded'))
    await write(join(selective, 'selected', 'kept', 'SKILL.md'), skill('kept'))
    await json(join(commandOnly, '.claude-plugin', 'plugin.json'), { name: 'command-only' })
    await write(join(commandOnly, 'commands', 'review.md'), 'Review the change')

    const discovery = await discoverClaudeSkillRoots(context(base, cwd))
    expect(discovery.notices).toContainEqual(expect.stringContaining('outside the plugin folder'))
    const inventory = await collectInstalledAgentSkills(discovery, { paths: [], notices: [] })
    expect(inventory.skills.filter(value => value.source === 'plugin').map(({ name, sourceLabel }) => ({ name, sourceLabel })))
      .toEqual([
        { name: 'kept', sourceLabel: 'selective' },
        { name: 'review', sourceLabel: 'command-only' },
      ])
  })
})

describe('Codex skill roots', () => {
  it('walks project roots from the marker root to cwd, adds .codex/skills layers, and honors skills.bundled', async () => {
    const base = await home()
    const project = join(base, 'project')
    const cwd = join(project, 'nested')
    await write(join(project, '.git'), 'gitdir: elsewhere')
    await mkdir(join(project, '.codex'), { recursive: true })
    await mkdir(cwd, { recursive: true })
    const codexHome = join(base, 'custom-codex')
    await write(join(codexHome, 'config.toml'), '[skills.bundled]\nenabled = false\n')
    const discovery = await discoverCodexSkillRoots(context(base, cwd, { CODEX_HOME: codexHome }))
    expect(paths(discovery, root => root.source === 'project')).toEqual([
      join(project, '.codex', 'skills'),
      join(cwd, '.agents', 'skills'),
      join(project, '.agents', 'skills'),
    ])
    expect(paths(discovery, root => root.source !== 'project' && root.source !== 'plugin')).toEqual([
      join(codexHome, 'skills'),
      join(base, '.agents', 'skills'),
      '/etc/codex/skills',
    ])
    expect(discovery.roots.every(root => root.layout === 'recursive' && root.maxDepth === 6)).toBe(true)
    // Host roots have no provided plugin namespace, so Codex discovers one per skill.
    expect(discovery.roots.every(root => root.resolvePluginNamespaces === true)).toBe(true)

    await write(join(codexHome, 'config.toml'), 'project_root_markers = []\n')
    const cwdOnly = await discoverCodexSkillRoots(context(base, cwd, { CODEX_HOME: codexHome }))
    expect(paths(cwdOnly, root => root.source === 'project')).toEqual([join(cwd, '.agents', 'skills')])
    expect(cwdOnly.roots).toContainEqual(expect.objectContaining({
      path: join(codexHome, 'skills', '.system'), source: 'system', followDirectorySymlinks: false,
    }))
  })

  // Round-two regression: repo roots listed before user roots labelled
  // ~/.agents/skills as Project for an agent launched in home without a repo.
  it('keeps user labels for a home-level agent without a repository', async () => {
    const base = await home()
    await write(join(base, '.agents', 'skills', 'mine', 'SKILL.md'), skill('mine'))
    const discovery = await discoverCodexSkillRoots(context(base, base))
    const inventory = await collectInstalledAgentSkills(discovery, { paths: [], notices: [] })
    expect(inventory.skills.map(({ name, source }) => ({ name, source }))).toEqual([{ name: 'mine', source: 'personal' }])
  })

  it('resolves plugins like Codex: default enablement, highest version, manifest formats, and path rules', async () => {
    const base = await home()
    const cwd = join(base, 'work')
    await mkdir(cwd, { recursive: true })
    const codexHome = join(base, '.codex')
    const cache = join(codexHome, 'plugins', 'cache', 'market')
    await write(join(codexHome, 'config.toml'), [
      '[plugins."alpha@market"]',
      '[plugins."beta@market"]', 'enabled = false',
      '[plugins."gamma@market"]', 'enabled = true',
      '[plugins."delta@market"]',
      '[plugins."epsilon@market"]',
      '[plugins."zeta@market"]',
      '[plugins."eta@market"]',
    ].join('\n'))
    // alpha: no `enabled` key, two versions where lexical order picks the wrong
    // one, and a `.claude-plugin` manifest whose explicit path replaces skills/.
    await json(join(cache, 'alpha', '1.9.0', '.claude-plugin', 'plugin.json'), { name: 'alpha' })
    const alpha = join(cache, 'alpha', '1.10.0')
    await json(join(alpha, '.claude-plugin', 'plugin.json'), { name: 'alpha', skills: './selected' })
    await mkdir(join(alpha, 'skills'), { recursive: true })
    await json(join(cache, 'beta', '1.0.0', '.codex-plugin', 'plugin.json'), { name: 'beta' })
    // gamma: `local` beats a higher version; every declared path is one Codex
    // rejects, so the default folder applies; migrated command skills add a root.
    const gamma = join(cache, 'gamma', 'local')
    await json(join(gamma, '.codex-plugin', 'plugin.json'), { name: 'gamma', skills: ['../escape', 'no-dot-slash', './', './a/../b'] })
    await mkdir(join(gamma, 'skills'), { recursive: true })
    await mkdir(join(gamma, '.codex-plugin', 'migrated-command-skills'), { recursive: true })
    await json(join(cache, 'gamma', '9.9.9', '.codex-plugin', 'plugin.json'), { name: 'gamma' })
    // delta: Agent Plugins format — the manifest cannot redirect skills, and
    // only direct children of `./skills` count.
    const delta = join(cache, 'delta', '1.0.0')
    await json(join(delta, 'plugin.json'), { $schema: AGENT_PLUGIN_SCHEMA, name: 'delta', skills: './elsewhere' })
    // epsilon: claims the Agent Plugins format with an unsupported schema.
    await json(join(cache, 'epsilon', '1.0.0', 'plugin.json'), { $schema: 'https://agent-plugins.org/schemas/2.0.0/plugin.schema.json', name: 'epsilon' })
    // zeta: a symlinked legacy manifest makes Codex reject the plugin.
    await json(join(base, 'elsewhere.json'), { name: 'zeta' })
    await mkdir(join(cache, 'zeta', '1.0.0', '.codex-plugin'), { recursive: true })
    await symlink(join(base, 'elsewhere.json'), join(cache, 'zeta', '1.0.0', '.codex-plugin', 'plugin.json'))
    // eta: a blank manifest name falls back to the plugin root's folder name,
    // which for an installed plugin is its VERSION folder (manifest.rs
    // resolve_raw_plugin_manifest) — not the configured plugin name.
    const eta = join(cache, 'eta', '2.0.0')
    await json(join(eta, '.codex-plugin', 'plugin.json'), { name: '   ' })
    await mkdir(join(eta, 'skills'), { recursive: true })

    const discovery = await discoverCodexSkillRoots(context(base, cwd))
    expect(discovery.roots.filter(root => root.source === 'plugin')).toEqual([
      { path: join(alpha, 'selected'), source: 'plugin', sourceLabel: 'alpha', layout: 'recursive', maxDepth: 6, namespace: 'alpha' },
      { path: join(gamma, 'skills'), source: 'plugin', sourceLabel: 'gamma', layout: 'recursive', maxDepth: 6, namespace: 'gamma' },
      { path: join(gamma, '.codex-plugin', 'migrated-command-skills'), source: 'plugin', sourceLabel: 'gamma', layout: 'recursive', maxDepth: 6, namespace: 'gamma' },
      { path: join(delta, 'skills'), source: 'plugin', sourceLabel: 'delta', layout: 'children', namespace: 'delta', containWithin: delta },
      { path: join(eta, 'skills'), source: 'plugin', sourceLabel: 'eta', layout: 'recursive', maxDepth: 6, namespace: '2.0.0' },
    ])
    expect(discovery.notices).toEqual(expect.arrayContaining([
      expect.stringContaining('Ignored 4 skill path(s) in the gamma'),
      expect.stringContaining('epsilon plugin because it declares an unsupported Agent Plugins schema'),
      expect.stringContaining('zeta plugin because its .codex-plugin/plugin.json is not a regular file'),
    ]))
  })

  it('orders versions by SemVer, including prereleases, before falling back to string order', () => {
    expect(['1.10.0', 'local-build', '1.9.0', '1.10.0-beta.2', '1.10.0-beta.10'].sort(compareCodexPluginVersions))
      .toEqual(['1.9.0', '1.10.0-beta.2', '1.10.0-beta.10', '1.10.0', 'local-build'])
  })

  it('applies skills.config selectors like Codex and always disables the Agent Code operator skill', async () => {
    const base = await home()
    const codexHome = join(base, '.codex')
    await write(join(codexHome, 'config.toml'), [
      '[[skills.config]]', 'name = "  review  "', 'enabled = false',
      '[[skills.config]]', 'name = "   "', 'enabled = false',
      '[[skills.config]]', 'name = "both"', 'path = "skills/both/SKILL.md"', 'enabled = false',
      '[[skills.config]]', 'path = "skills/draft/SKILL.md"', 'enabled = true',
    ].join('\n'))
    const discovery = await discoverCodexSkillRoots(context(base, base))
    expect(discovery.enablementRules).toEqual([
      { name: 'review', enabled: false },
      { path: resolve(codexHome, 'skills/draft/SKILL.md'), enabled: true },
      { path: expect.stringMatching(/agent-code-computer-execution[\\/]SKILL\.md$/), enabled: false },
    ])
  })
})

describe('OpenCode skill roots', () => {
  it('parses disable flags case-insensitively and drops only the roots each flag names', async () => {
    const base = await home()
    const cwd = join(base, 'work')
    await mkdir(cwd, { recursive: true })
    const claudeOff = await discoverOpencodeSkillRoots(context(base, cwd, { OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: 'TRUE' }))
    expect(claudeOff.roots.some(root => root.path.includes('.claude'))).toBe(false)
    expect(paths(claudeOff, root => root.source === 'personal')).toContain(join(base, '.agents', 'skills'))

    const customConfig = join(base, 'custom-opencode')
    const externalOff = await discoverOpencodeSkillRoots(context(base, cwd, {
      OPENCODE_DISABLE_EXTERNAL_SKILLS: 'True',
      OPENCODE_CONFIG_DIR: customConfig,
    }))
    expect(externalOff.roots.some(root => root.includeHidden)).toBe(false)
    expect(paths(externalOff, root => root.source === 'personal')).toEqual(expect.arrayContaining([
      join(customConfig, 'skill'),
      join(customConfig, 'skills'),
      join(base, '.config', 'opencode', 'skill'),
    ]))
  })

  it('walks project folders only up to the git worktree', async () => {
    const base = await home()
    const project = join(base, 'project')
    const cwd = join(project, 'nested')
    await write(join(project, '.git'), 'gitdir: elsewhere')
    await mkdir(cwd, { recursive: true })
    const discovery = await discoverOpencodeSkillRoots(context(base, cwd))
    const projectRoots = paths(discovery, root => root.source === 'project')
    expect(projectRoots).toEqual(expect.arrayContaining([
      join(cwd, '.agents', 'skills'),
      join(project, '.claude', 'skills'),
      join(project, '.opencode', 'skill'),
      join(cwd, '.opencode', 'skills'),
    ]))
    expect(projectRoots.every(path => path.startsWith(project))).toBe(true)
  })
})
