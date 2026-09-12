import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentSkillRoot, AgentSkillsSnapshot } from '@shared/types/agentSkills.js'
import { collectInstalledAgentSkills } from './inventory.js'

const temporary: string[] = []
async function temp() {
  const path = await mkdtemp(join(tmpdir(), 'agent-skill-inventory-'))
  temporary.push(path)
  return path
}
async function write(path: string, body: string) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, body)
}
const skill = (name: string) => `---\nname: ${name}\ndescription: Description for ${name}\n---\nPRIVATE BODY !\`do-not-execute\`\n`
const unmanaged = { paths: [], notices: [] }
const root = (path: string, layout: AgentSkillRoot['layout'], extra: Partial<AgentSkillRoot> = {}): AgentSkillRoot =>
  ({ path, source: 'personal', layout, ...extra })
const names = (result: AgentSkillsSnapshot) => result.skills.map(value => value.name)
afterEach(async () => {
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('installed skill inventory', () => {
  it('labels managed deployments and returns metadata only, without modifying files', async () => {
    const base = await temp()
    const managedPath = join(base, 'personal', 'conventions', 'SKILL.md')
    await write(managedPath, skill('agent-code-conventions'))
    await write(join(base, 'personal', 'external', 'SKILL.md'), skill('external'))
    await write(join(base, 'project', 'review', 'SKILL.md'), skill('review'))
    await write(join(base, 'system', 'creator', 'SKILL.md'), skill('skill-creator'))
    const result = await collectInstalledAgentSkills({
      roots: [
        root(join(base, 'personal'), 'children'),
        root(join(base, 'project'), 'children', { source: 'project' }),
        root(join(base, 'system'), 'children', { source: 'system', sourceLabel: 'Codex defaults' }),
      ],
      notices: [],
    }, { paths: [managedPath], notices: [] })
    expect(result.skills.map(({ name, source, sourceLabel }) => ({ name, source, sourceLabel }))).toEqual([
      { name: 'agent-code-conventions', source: 'agent-code', sourceLabel: undefined },
      { name: 'external', source: 'personal', sourceLabel: undefined },
      { name: 'review', source: 'project', sourceLabel: undefined },
      { name: 'skill-creator', source: 'system', sourceLabel: 'Codex defaults' },
    ])
    expect(JSON.stringify(result)).not.toContain('PRIVATE BODY')
    expect(result.notices).toEqual([])
    expect(await readFile(managedPath, 'utf8')).toBe(skill('agent-code-conventions'))
  })

  // Regression for the #903 review: a generic walk fabricated a skill named
  // after the root from a stray `skills/SKILL.md` and listed archived nested
  // skills Claude never loads (loadSkillsDir.ts loadSkillsFromSkillsDir).
  it('mirrors Claude skill folders: direct children only, the root itself only for plugin skill paths', async () => {
    const base = await temp()
    await write(join(base, 'skills', 'SKILL.md'), skill('stray'))
    await write(join(base, 'skills', 'valid', 'SKILL.md'), skill('valid'))
    await write(join(base, 'skills', 'archive', 'old', 'SKILL.md'), skill('archived'))
    await write(join(base, 'plugin-skill', 'SKILL.md'), skill('plugin-root'))
    await write(join(base, 'plugin-skill', 'child', 'SKILL.md'), skill('plugin-child'))
    const result = await collectInstalledAgentSkills({
      roots: [
        root(join(base, 'skills'), 'children'),
        root(join(base, 'plugin-skill'), 'children', { rootMayBeSkill: true }),
      ],
      notices: [],
    }, unmanaged)
    expect(names(result)).toEqual(['plugin-root', 'valid'])
    expect(result.notices).toEqual([])
  })

  it('mirrors Codex recursive discovery: nested skills, the six-segment depth limit, and hidden folders', async () => {
    const base = await temp()
    await write(join(base, 'outer', 'SKILL.md'), skill('outer'))
    await write(join(base, 'outer', 'inner', 'SKILL.md'), skill('inner'))
    await write(join(base, '1', '2', '3', '4', '5', 'SKILL.md'), skill('depth-six'))
    await write(join(base, '1', '2', '3', '4', '5', '6', 'SKILL.md'), skill('depth-seven'))
    await write(join(base, '.hidden', 'x', 'SKILL.md'), skill('hidden'))
    const skipHidden = await collectInstalledAgentSkills({ roots: [root(base, 'recursive', { maxDepth: 6 })], notices: [] }, unmanaged)
    expect(names(skipHidden)).toEqual(['depth-six', 'inner', 'outer'])
    // The provider's own depth limit is real behavior, not an incomplete scan.
    expect(skipHidden.notices).toEqual([])
    const includeHidden = await collectInstalledAgentSkills({
      roots: [root(base, 'recursive', { maxDepth: 6, includeHidden: true })],
      notices: [],
    }, unmanaged)
    expect(names(includeHidden)).toEqual(['depth-six', 'hidden', 'inner', 'outer'])
  })

  it('reads Claude command Markdown recursively and lets SKILL.md own its folder', async () => {
    const base = await temp()
    await write(join(base, 'commands', 'deploy.md'), 'Deploy the app')
    await write(join(base, 'commands', 'ops', 'rollback.md'), '---\nname: rollback\ndescription: Roll back\n---\n')
    await write(join(base, 'commands', 'bundle', 'SKILL.md'), skill('bundle'))
    await write(join(base, 'commands', 'bundle', 'notes.md'), 'supporting notes, not a command')
    await write(join(base, 'commands', 'bundle', 'nested', 'extra.md'), 'loaded unless the folder is a leaf')
    await write(join(base, 'single.md'), 'One command file')
    const legacy = await collectInstalledAgentSkills({
      roots: [
        root(join(base, 'commands'), 'commands', { optionalFrontmatter: true, includeHidden: true }),
        root(join(base, 'single.md'), 'commands', { optionalFrontmatter: true }),
      ],
      notices: [],
    }, unmanaged)
    expect(names(legacy)).toEqual(['bundle', 'deploy', 'extra', 'rollback', 'single'])
    const plugin = await collectInstalledAgentSkills({
      roots: [root(join(base, 'commands'), 'commands', { optionalFrontmatter: true, stopAtSkillDirectory: true })],
      notices: [],
    }, unmanaged)
    expect(names(plugin)).toEqual(['bundle', 'deploy', 'rollback'])
  })

  it('deduplicates linked physical skills and terminates directory cycles without collapsing equal names', async () => {
    const base = await temp()
    await write(join(base, 'one', 'SKILL.md'), skill('same-name'))
    await write(join(base, 'two', 'SKILL.md'), skill('same-name'))
    await symlink(join(base, 'one'), join(base, 'linked'), 'dir')
    await symlink(base, join(base, 'cycle'), 'dir')
    const result = await collectInstalledAgentSkills({ roots: [root(base, 'recursive', { maxDepth: 6 })], notices: [] }, unmanaged)
    expect(names(result)).toEqual(['same-name', 'same-name'])
    expect(result.notices).toEqual([])
  })

  it('reports malformed headers and read failures while retaining valid siblings and missing-root emptiness', async () => {
    const base = await temp()
    await write(join(base, 'bad', 'SKILL.md'), '---\nname: [secret value\n---\nPRIVATE BODY')
    await write(join(base, 'oversize', 'SKILL.md'), '---\nname: large\ndescription: ' + 'x'.repeat(70_000) + '\n---')
    await write(join(base, 'ok', 'SKILL.md'), skill('ok') + 'large body'.repeat(20_000))
    const result = await collectInstalledAgentSkills({
      roots: [root(base, 'children'), root(join(base, 'missing'), 'children', { source: 'system' })],
      notices: ['Provider catalog incomplete.'],
    }, { paths: [], notices: ['Managed deployment incomplete.'] })
    expect(names(result)).toEqual(['ok'])
    expect(result.notices).toHaveLength(4)
    expect(JSON.stringify(result)).not.toContain('secret value')
    expect(result.notices.join('\n')).toContain('Provider catalog incomplete.')
    expect(result.notices.join('\n')).not.toContain('/missing')
  })

  it('accepts Claude optional metadata while standard roots require skill metadata', async () => {
    const base = await temp()
    await write(join(base, 'claude', 'implicit', 'SKILL.md'), 'Instructions with no header')
    await write(join(base, 'standard', 'invalid', 'SKILL.md'), 'Instructions with no header')
    const result = await collectInstalledAgentSkills({
      roots: [
        root(join(base, 'claude'), 'children', { optionalFrontmatter: true }),
        root(join(base, 'standard'), 'children'),
      ],
      notices: [],
    }, unmanaged)
    expect(names(result)).toEqual(['implicit'])
    expect(result.notices).toHaveLength(1)
  })

  // Regression for the #903 review: failed reads under skill-path roots never
  // touched the budget, so malformed plugins drove unbounded parsing in main.
  it('charges every failed read to one budget and caps failure notices', async () => {
    const base = await temp()
    for (let index = 0; index < 12; index += 1) {
      await write(join(base, `plugin-${index}`, 'SKILL.md'), '---\nname: [broken\n---\n')
    }
    const roots = Array.from({ length: 12 }, (_, index) =>
      root(join(base, `plugin-${index}`), 'children', { rootMayBeSkill: true }))
    const capped = await collectInstalledAgentSkills({ roots, notices: [] }, unmanaged, { failureNotices: 3 })
    expect(capped.notices).toEqual([
      ...[0, 1, 2].map(index => `Could not read skill metadata: ${join(base, `plugin-${index}`, 'SKILL.md')}`),
      'Could not list 9 more skill files.',
    ])
    // Each malformed plugin root costs two units — the `<root>/SKILL.md` probe
    // and the metadata read — so a budget of 4 reaches exactly two reads before
    // the remaining ten roots are refused. A count of 4 would mean probes had
    // stopped being charged again.
    const budgeted = await collectInstalledAgentSkills({ roots, notices: [] }, unmanaged, { entries: 4 })
    expect(budgeted.notices.filter(notice => notice.startsWith('Could not read skill metadata'))).toHaveLength(2)
    expect(budgeted.notices).toContain('Skill discovery reached its scan limit; the list may be incomplete.')
  })

  it.skipIf(process.platform === 'win32')('rejects a FIFO skill without waiting for a writer (requires POSIX mkfifo)', async () => {
    const base = await temp()
    await mkdir(join(base, 'pipe'))
    execFileSync('mkfifo', [join(base, 'pipe', 'SKILL.md')])
    const result = await collectInstalledAgentSkills({ roots: [root(base, 'children')], notices: [] }, unmanaged)
    expect(result.skills).toEqual([])
    expect(result.notices).toEqual([expect.stringContaining('/pipe/SKILL.md')])
  })

  it('applies ordered enablement rules by canonical path and by name, later rules winning', async () => {
    const base = await temp()
    await write(join(base, 'operator', 'SKILL.md'), skill('agent-code-computer-execution'))
    await write(join(base, 'review', 'SKILL.md'), skill('review'))
    await write(join(base, 'draft', 'SKILL.md'), skill('draft'))
    const result = await collectInstalledAgentSkills({
      roots: [root(base, 'recursive', { maxDepth: 6 })],
      notices: [],
      enablementRules: [
        { path: join(base, 'operator', 'SKILL.md'), enabled: false },
        { name: 'review', enabled: false },
        { name: 'draft', enabled: false },
        { path: join(base, 'draft', 'SKILL.md'), enabled: true },
      ],
    }, unmanaged)
    expect(result.skills.map(({ name, disabled }) => ({ name, disabled: disabled === true }))).toEqual([
      { name: 'agent-code-computer-execution', disabled: true },
      { name: 'draft', disabled: false },
      { name: 'review', disabled: true },
    ])
  })

  // Round-two regression: a global visited-folder set read a folder named by
  // two roots only under the first layout, silently dropping plugin commands.
  it('reads one folder under every layout that names it', async () => {
    const base = await temp()
    await write(join(base, 'shared', 'a', 'SKILL.md'), skill('a'))
    await write(join(base, 'shared', 'command.md'), 'A plugin command')
    const result = await collectInstalledAgentSkills({
      roots: [
        root(join(base, 'shared'), 'children', { source: 'plugin' }),
        root(join(base, 'shared'), 'commands', { source: 'plugin', optionalFrontmatter: true, stopAtSkillDirectory: true }),
      ],
      notices: [],
    }, unmanaged)
    expect(names(result)).toEqual(['a', 'command'])
  })

  // Round-two regression: missing command roots were `stat`ed without charge,
  // so a manifest listing thousands of absent paths escaped the budget.
  it('charges root probes to the budget so absent roots cannot starve or bypass the limit', async () => {
    const base = await temp()
    await write(join(base, 'late', 'valid', 'SKILL.md'), skill('late'))
    const missing = Array.from({ length: 20 }, (_, index) => [
      root(join(base, `absent-command-${index}`), 'commands', { optionalFrontmatter: true }),
      root(join(base, `absent-skill-${index}`), 'children', { rootMayBeSkill: true }),
    ]).flat()
    const roots = [...missing, root(join(base, 'late'), 'children')]
    const budgeted = await collectInstalledAgentSkills({ roots, notices: [] }, unmanaged, { entries: 10 })
    expect(names(budgeted)).toEqual([])
    expect(budgeted.notices).toContain('Skill discovery reached its scan limit; the list may be incomplete.')
    const unbudgeted = await collectInstalledAgentSkills({ roots, notices: [] }, unmanaged)
    expect(names(unbudgeted)).toEqual(['late'])
    expect(unbudgeted.notices).toEqual([])
  })

  it('skips hidden skill folders and linked folders when the provider does', async () => {
    const base = await temp()
    await write(join(base, 'root', '.hidden', 'SKILL.md'), skill('hidden'))
    await write(join(base, 'root', 'visible', 'SKILL.md'), skill('visible'))
    await write(join(base, 'elsewhere', 'SKILL.md'), skill('linked'))
    await symlink(join(base, 'elsewhere'), join(base, 'root', 'linked'), 'dir')
    const strict = await collectInstalledAgentSkills({
      roots: [root(join(base, 'root'), 'children', { followDirectorySymlinks: false })],
      notices: [],
    }, unmanaged)
    expect(names(strict)).toEqual(['visible'])
    const permissive = await collectInstalledAgentSkills({
      roots: [root(join(base, 'root'), 'children', { includeHidden: true })],
      notices: [],
    }, unmanaged)
    expect(names(permissive)).toEqual(['hidden', 'linked', 'visible'])
  })

  // Round-two regression: Codex qualifies plugin skill names before applying
  // name rules, so `sample:review` must disable only the plugin copy.
  it('qualifies namespaced plugin skills for display and name-rule matching', async () => {
    const base = await temp()
    await write(join(base, 'plugin', 'review', 'SKILL.md'), skill('review'))
    await write(join(base, 'personal', 'review', 'SKILL.md'), skill('review'))
    const result = await collectInstalledAgentSkills({
      roots: [
        root(join(base, 'personal'), 'children'),
        root(join(base, 'plugin'), 'children', { source: 'plugin', namespace: 'sample' }),
      ],
      notices: [],
      enablementRules: [{ name: 'sample:review', enabled: false }],
    }, unmanaged)
    expect(result.skills.map(({ name, disabled }) => ({ name, disabled: disabled === true }))).toEqual([
      { name: 'review', disabled: false },
      { name: 'sample:review', disabled: true },
    ])
    const unqualified = await collectInstalledAgentSkills({
      roots: [root(join(base, 'plugin'), 'children', { source: 'plugin', namespace: 'sample' })],
      notices: [],
      enablementRules: [{ name: 'review', enabled: false }],
    }, unmanaged)
    expect(unqualified.skills.map(({ disabled }) => disabled === true)).toEqual([false])
  })

  // Round-three regression: Codex drops an Agent Plugin skill whose real path
  // leaves the plugin (loader/host.rs "resolves outside plugin root"), while a
  // link that stays inside the plugin is still a skill.
  it('rejects plugin skills whose real path leaves the containing plugin', async () => {
    const base = await temp()
    const plugin = join(base, 'plugin')
    await write(join(plugin, 'skills', 'inside', 'SKILL.md'), skill('inside'))
    await write(join(plugin, 'shared', 'SKILL.md'), skill('shared'))
    await symlink(join(plugin, 'shared'), join(plugin, 'skills', 'linked-inside'), 'dir')
    await write(join(base, 'outside', 'SKILL.md'), skill('outside'))
    await symlink(join(base, 'outside'), join(plugin, 'skills', 'smuggled'), 'dir')
    const result = await collectInstalledAgentSkills({
      roots: [root(join(plugin, 'skills'), 'children', { source: 'plugin', namespace: 'delta', containWithin: plugin })],
      notices: [],
    }, unmanaged)
    expect(names(result)).toEqual(['delta:inside', 'delta:shared'])
    expect(result.notices).toEqual([
      `Skipped a plugin skill that resolves outside its plugin folder: ${join(plugin, 'skills', 'smuggled', 'SKILL.md')}`,
    ])
  })

  // Round-three regression: host roots have no provided namespace, so Codex
  // derives one per skill (namespace.rs SkillNamespaceResolver). A personal
  // link into an installed plugin showed a bare name and escaped name rules.
  it('derives Codex namespaces for host-root skills from linked targets, plugin folders, and ancestors', async () => {
    const base = await temp()
    const installed = join(base, 'cache', 'sample', '1.0.0')
    await write(join(installed, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'sample' }))
    await write(join(installed, 'skills', 'review', 'SKILL.md'), skill('review'))
    const personal = join(base, 'personal')
    await mkdir(personal, { recursive: true })
    await symlink(join(installed, 'skills', 'review'), join(personal, 'review'), 'dir')
    // A plugin folder copied into the root whose manifest has no name uses the
    // folder name; an unparseable nested manifest is ignored.
    await write(join(personal, 'superpowers', '.claude-plugin', 'plugin.json'), '{}')
    await write(join(personal, 'superpowers', 'skills', 'brainstorming', 'SKILL.md'), skill('brainstorming'))
    await write(join(personal, 'broken', '.codex-plugin', 'plugin.json'), '{ not json')
    await write(join(personal, 'broken', 'skills', 'draft', 'SKILL.md'), skill('draft'))
    await write(join(personal, 'plain', 'SKILL.md'), skill('plain'))
    const host = { maxDepth: 6, resolvePluginNamespaces: true }
    const result = await collectInstalledAgentSkills({
      roots: [root(personal, 'recursive', host)],
      notices: [],
      enablementRules: [{ name: 'sample:review', enabled: false }],
    }, unmanaged)
    expect(result.skills.map(({ name, disabled }) => ({ name, disabled: disabled === true }))).toEqual([
      { name: 'draft', disabled: false },
      { name: 'plain', disabled: false },
      { name: 'sample:review', disabled: true },
      { name: 'superpowers:brainstorming', disabled: false },
    ])
    expect(result.notices).toEqual([])
    // A root that itself sits inside a plugin inherits that plugin's name.
    const inherited = await collectInstalledAgentSkills({
      roots: [root(join(installed, 'skills'), 'recursive', host)],
      notices: [],
    }, unmanaged)
    expect(names(inherited)).toEqual(['sample:review'])
  })
})
