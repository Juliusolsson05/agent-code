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
      'Could not read metadata for 9 more skill files.',
    ])
    const budgeted = await collectInstalledAgentSkills({ roots, notices: [] }, unmanaged, { entries: 4 })
    expect(budgeted.notices.filter(notice => notice.startsWith('Could not read skill metadata'))).toHaveLength(4)
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
})
