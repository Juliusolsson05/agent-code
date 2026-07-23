import { mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'

import { journalTemporaryPath, SkillPathSafety } from './skillPathSafety.js'
import { sha256Text } from './renderSkill.js'
import type { AgentCodeConventionsTarget } from './targets.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function fixture(): Promise<{
  root: string
  target: AgentCodeConventionsTarget
  safety: SkillPathSafety
}> {
  const root = await mkdtemp(join(tmpdir(), 'agent-code-skill-path-safety-'))
  temporaryDirectories.push(root)
  const skillsDirectory = join(root, '.agents', 'skills')
  const skillDirectory = join(skillsDirectory, 'agent-code-conventions')
  return {
    root,
    target: {
      id: 'agents-standard-personal-skills',
      providers: ['codex'],
      providerNames: ['Codex'],
      skillsDirectory,
      skillDirectory,
      skillFile: join(skillDirectory, 'SKILL.md'),
    },
    safety: new SkillPathSafety(root),
  }
}

describe('SkillPathSafety', () => {
  it('owns directory creation, bounded inspection, and version-checked removal', async () => {
    const { target, safety } = await fixture()
    await expect(safety.inspectTarget(target)).resolves.toMatchObject({
      kind: 'missing',
      directoryExists: false,
    })
    const directory = await safety.ensureTargetDirectory(target)
    expect(directory.created).toBe(true)
    await writeFile(target.skillFile, 'owned bytes')
    const inspected = await safety.inspectTarget(target)
    if (inspected.kind !== 'file') throw new Error('expected a regular file inspection')

    await expect(safety.unlinkOwnedRegularFile(
      target.skillFile,
      inspected.version,
      sha256Text('owned bytes'),
      journalTemporaryPath(target.skillFile, 'delete-owned-bytes'),
    )).resolves.toBe('deleted')
    await safety.removeEmptyOwnedDirectory(target.skillDirectory, directory.identity)
    await expect(stat(target.skillDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('cleans only the exact operation-derived temporary sibling', async () => {
    const { target, safety } = await fixture()
    await safety.ensureTargetDirectory(target)
    const journaled = journalTemporaryPath(target.skillFile, '../operation/with/separators')
    const unrelated = join(target.skillDirectory, '.SKILL.md.someone-else.tmp')
    await writeFile(journaled, 'partial')
    await writeFile(unrelated, 'preserve')

    await safety.cleanupJournaledTemporaryFile(journaled)

    await expect(stat(journaled)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(unrelated, 'utf8')).resolves.toBe('preserve')
  })

  it('finishes an owned delete quarantine but restores unverified captured bytes', async () => {
    const { target, safety } = await fixture()
    await safety.ensureTargetDirectory(target)
    const quarantine = journalTemporaryPath(target.skillFile, 'delete-crash')
    await writeFile(quarantine, 'owned bytes')

    await expect(safety.recoverJournaledDelete(
      target.skillFile,
      quarantine,
      sha256Text('owned bytes'),
    )).resolves.toBe('completed')
    await expect(stat(quarantine)).rejects.toMatchObject({ code: 'ENOENT' })

    await writeFile(quarantine, 'external replacement')
    await expect(safety.recoverJournaledDelete(
      target.skillFile,
      quarantine,
      sha256Text('owned bytes'),
    )).resolves.toBe('restored')
    await expect(readFile(target.skillFile, 'utf8')).resolves.toBe('external replacement')
    await expect(stat(quarantine)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
