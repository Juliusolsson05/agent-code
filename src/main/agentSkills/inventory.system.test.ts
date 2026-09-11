import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentSkillDiscovery } from '@shared/types/agentSkills.js'
import { collectInstalledAgentSkills } from './inventory.js'

const temporary: string[] = []
async function root() {
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
afterEach(async () => {
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('installed skill inventory', () => {
  it('combines managed, personal, project and system metadata without returning bodies or modifying files', async () => {
    const path = await root()
    const managedPath = join(path, 'personal', 'conventions', 'SKILL.md')
    await write(managedPath, skill('agent-code-conventions'))
    await write(join(path, 'personal', 'external', 'SKILL.md'), skill('external'))
    await write(join(path, 'project', 'review', 'SKILL.md'), skill('review'))
    await write(join(path, 'personal', '.system', 'creator', 'SKILL.md'), skill('skill-creator'))
    // A helper nested under an installed skill must not become another skill.
    await write(join(path, 'personal', 'external', 'references', 'SKILL.md'), skill('not-installed'))
    const discovery: AgentSkillDiscovery = {
      roots: [
        { path: join(path, 'personal'), source: 'personal' },
        { path: join(path, 'project'), source: 'project' },
        { path: join(path, 'personal', '.system'), source: 'system' },
      ], notices: [],
    }
    const result = await collectInstalledAgentSkills(discovery, { paths: [managedPath], notices: [] })
    expect(result.skills.map(({ name, source }) => ({ name, source }))).toEqual([
      { name: 'agent-code-conventions', source: 'agent-code' },
      { name: 'external', source: 'personal' },
      { name: 'review', source: 'project' },
      { name: 'skill-creator', source: 'system' },
    ])
    expect(JSON.stringify(result)).not.toContain('PRIVATE BODY')
    expect(result.notices).toEqual([])
    expect(await readFile(managedPath, 'utf8')).toBe(skill('agent-code-conventions'))
  })

  it('deduplicates linked physical skills and terminates directory cycles without collapsing equal names', async () => {
    const path = await root()
    await write(join(path, 'one', 'SKILL.md'), skill('same-name'))
    await write(join(path, 'two', 'SKILL.md'), skill('same-name'))
    await symlink(join(path, 'one'), join(path, 'linked'), 'dir')
    await symlink(path, join(path, 'cycle'), 'dir')
    const result = await collectInstalledAgentSkills({ roots: [{ path, source: 'personal' }], notices: [] }, unmanaged)
    expect(result.skills).toHaveLength(2)
    expect(result.skills.map(value => value.name)).toEqual(['same-name', 'same-name'])
    expect(result.notices).toEqual([])
  })

  it('reports malformed headers and read failures while retaining valid siblings and missing-root emptiness', async () => {
    const path = await root()
    await write(join(path, 'bad', 'SKILL.md'), '---\nname: [secret value\n---\nPRIVATE BODY')
    await write(join(path, 'oversize', 'SKILL.md'), '---\nname: large\ndescription: ' + 'x'.repeat(70_000) + '\n---')
    await write(join(path, 'ok', 'SKILL.md'), skill('ok') + 'large body'.repeat(20_000))
    const result = await collectInstalledAgentSkills({
      roots: [{ path, source: 'personal' }, { path: join(path, 'missing'), source: 'system' }],
      notices: ['Provider catalog incomplete.'],
    }, { paths: [], notices: ['Managed deployment incomplete.'] })
    expect(result.skills.map(value => value.name)).toEqual(['ok'])
    expect(result.notices).toHaveLength(4)
    expect(JSON.stringify(result)).not.toContain('secret value')
    expect(result.notices.join('\n')).toContain('Provider catalog incomplete.')
    expect(result.notices.join('\n')).not.toContain('/missing')
  })

  it('accepts Claude optional metadata and legacy Markdown while standard roots require skill metadata', async () => {
    const path = await root()
    await write(join(path, 'claude', 'implicit', 'SKILL.md'), 'Instructions with no header')
    await write(join(path, 'commands', 'deploy.md'), 'Deployment instructions')
    await write(join(path, 'standard', 'invalid', 'SKILL.md'), 'Instructions with no header')
    const result = await collectInstalledAgentSkills({
      roots: [
        { path: join(path, 'claude'), source: 'personal', optionalFrontmatter: true },
        { path: join(path, 'commands'), source: 'personal', legacyCommands: true },
        { path: join(path, 'standard'), source: 'personal' },
      ], notices: [],
    }, unmanaged)
    expect(result.skills.map(value => value.name)).toEqual(['deploy', 'implicit'])
    expect(result.notices).toHaveLength(1)
  })

  it.skipIf(process.platform === 'win32')('rejects a FIFO skill without waiting for a writer (requires POSIX mkfifo)', async () => {
    const path = await root()
    await mkdir(join(path, 'pipe'))
    execFileSync('mkfifo', [join(path, 'pipe', 'SKILL.md')])
    const result = await collectInstalledAgentSkills({ roots: [{ path, source: 'personal' }], notices: [] }, unmanaged)
    expect(result.skills).toEqual([])
    expect(result.notices).toEqual([expect.stringContaining('/pipe/SKILL.md')])
  })
})
