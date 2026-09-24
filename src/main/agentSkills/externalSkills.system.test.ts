import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { collectExternalAgentSkills, resolveExternalSkillFolder } from './externalSkills.js'
import { readSkillLock } from './skillLock.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function skillFolder(root: string, name: string, description = `The ${name} skill.`) {
  await mkdir(join(root, name), { recursive: true })
  await writeFile(join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`)
}

// The on-disk shape `npx skills add -g` produces (vercel-labs/skills 1.7):
// one real folder in ~/.agents/skills, a symlink per agent root, and a v3 lock.
async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'agent-code-external-skills-')))
  directories.push(home)
  const agents = join(home, '.agents', 'skills')
  const claude = join(home, '.claude', 'skills')
  await mkdir(claude, { recursive: true })
  await skillFolder(agents, 'grill-me')
  await symlink(join(agents, 'grill-me'), join(claude, 'grill-me'))
  await skillFolder(claude, 'my-notes')
  await skillFolder(agents, 'managed-one')
  await writeFile(join(home, '.agents', '.skill-lock.json'), JSON.stringify({
    version: 3,
    skills: {
      'grill-me': {
        source: 'mattpocock/skills',
        sourceType: 'github',
        sourceUrl: 'https://github.com/mattpocock/skills.git',
        skillPath: 'skills/grill-me/SKILL.md',
        skillFolderHash: 'abc',
      },
    },
  }))
  const service = {
    getPersonalSkillRoots: async () => [
      { id: 'agents-standard-personal-skills', providers: ['codex', 'opencode', 'pi'] as const, skillsDirectory: agents, displayPath: '~/.agents/skills' },
      { id: 'claude-personal-skills', providers: ['claude', 'opencode'] as const, skillsDirectory: claude, displayPath: '~/.claude/skills' },
    ].map(root => ({ ...root, providers: [...root.providers] })),
    getInstalledSkillLocations: async () => ({ paths: [join(agents, 'managed-one', 'SKILL.md')], notices: [] }),
  }
  return { home, agents, claude, service }
}

describe('collectExternalAgentSkills', () => {
  it('lists unmanaged skills per root, marks npx symlinks and reads lock provenance', async () => {
    const { home, service } = await fixture()
    const snapshot = await collectExternalAgentSkills(service, {
      readLock: () => readSkillLock(join(home, '.agents', '.skill-lock.json')),
    })
    expect(snapshot.skills.map(skill => skill.name)).toEqual(['grill-me', 'my-notes'])
    expect(snapshot.skills[0]).toMatchObject({
      provenance: { installer: 'npx skills', source: 'mattpocock/skills' },
      locations: [
        { targetId: 'agents-standard-personal-skills', folder: 'grill-me', linked: false },
        { targetId: 'claude-personal-skills', folder: 'grill-me', linked: true },
      ],
    })
    expect(snapshot.skills[1]).not.toHaveProperty('provenance')
  })

  it('resolves reveal targets only from a root id and one folder name', async () => {
    const { claude, service } = await fixture()
    expect(await resolveExternalSkillFolder(service, 'claude-personal-skills', 'my-notes')).toBe(join(claude, 'my-notes'))
    expect(await resolveExternalSkillFolder(service, 'claude-personal-skills', '../escape')).toBeNull()
    expect(await resolveExternalSkillFolder(service, 'claude-personal-skills', 'a/b')).toBeNull()
    expect(await resolveExternalSkillFolder(service, 'unknown-root', 'my-notes')).toBeNull()
  })

  it('treats a missing or malformed lock file as no provenance', async () => {
    expect((await readSkillLock('/nonexistent/.skill-lock.json')).size).toBe(0)
    const { home } = await fixture()
    await writeFile(join(home, '.agents', '.skill-lock.json'), '{not json')
    expect((await readSkillLock(join(home, '.agents', '.skill-lock.json'))).size).toBe(0)
  })
})
