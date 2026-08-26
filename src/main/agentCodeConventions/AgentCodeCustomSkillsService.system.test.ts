import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'

import { AgentCodeConventionsService } from './AgentCodeConventionsService.js'
import { renderAgentCodeCustomSkill } from './renderCustomSkill.js'
import { customArtifactKey } from './customSkillOwnershipPolicy.js'
import { sha256Text } from './renderSkill.js'
import {
  createEmptyAgentCodeConventionsDocument,
  type AgentCodeCustomSkillRecord,
} from '@shared/types/agentCodeConventions.js'
import type {
  AgentCodeConventionsTarget,
  ResolvedAgentCodeConventionsTargets,
} from './targets.js'

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-code-custom-skills-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory =>
    rm(directory, { recursive: true, force: true })))
})

function target(id: string, skillsDirectory: string): AgentCodeConventionsTarget {
  const skillDirectory = join(skillsDirectory, 'agent-code-conventions')
  return {
    id,
    providers: ['codex'],
    providerNames: ['Codex'],
    skillsDirectory,
    skillDirectory,
    skillFile: join(skillDirectory, 'SKILL.md'),
  }
}

async function harness() {
  const root = await temporaryDirectory()
  const targets = [
    target('agents-standard', join(root, '.agents', 'skills')),
    target('claude-personal', join(root, '.claude', 'skills')),
  ]
  const resolved: ResolvedAgentCodeConventionsTargets = { targets, unsupportedProviders: [] }
  const stateFilePath = join(root, 'state', 'conventions.json')
  let sequence = 0
  const service = new AgentCodeConventionsService({
    stateFilePath,
    homeDirectory: root,
    resolveTargets: async () => resolved,
    now: () => new Date('2026-08-26T00:00:00.000Z'),
    operationId: () => `id-${++sequence}`,
  })
  await service.initialize()
  return { root, stateFilePath, targets, service }
}

function customPath(targetValue: AgentCodeConventionsTarget, name: string): string {
  return join(targetValue.skillsDirectory, name, 'SKILL.md')
}

async function writeFileWithParents(filePath: string, text: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, text)
}

describe('Agent Code custom skill management', () => {
  it('keeps drafts app-owned and independently materializes multiple enabled skills', async () => {
    const { targets, service } = await harness()
    const drafted = await service.createCustomSkill({
      expectedRevision: 0,
      name: 'review-code',
      description: 'Review code carefully',
      markdown: '# Review',
      enabled: false,
    })
    expect(drafted).toMatchObject({ ok: true, snapshot: { revision: 1 } })
    await expect(stat(customPath(targets[0]!, 'review-code'))).rejects.toMatchObject({ code: 'ENOENT' })
    if (!drafted.ok) throw new Error('draft failed')
    const first = drafted.snapshot.skills[0]!

    const enabled = await service.setCustomSkillEnabled({
      expectedRevision: 1,
      skillId: first.id,
      enabled: true,
    })
    expect(enabled).toMatchObject({ ok: true, snapshot: { skills: [{ health: 'active' }] } })
    if (!enabled.ok) throw new Error('enable failed')
    const second = await service.createCustomSkill({
      expectedRevision: enabled.snapshot.revision,
      name: 'write-release-notes',
      description: 'Write concise release notes',
      markdown: '# Release notes',
      enabled: true,
    })
    expect(second).toMatchObject({ ok: true, snapshot: { skills: [{ health: 'active' }, { health: 'active' }] } })

    for (const targetValue of targets) {
      expect(await readFile(customPath(targetValue, 'review-code'), 'utf8')).toBe(
        renderAgentCodeCustomSkill(first),
      )
      expect(await readFile(customPath(targetValue, 'write-release-notes'), 'utf8')).toContain(
        'name: write-release-notes',
      )
    }
  })

  it('refuses an unmanaged exact destination without importing or overwriting it', async () => {
    const { targets, service } = await harness()
    const unmanagedPath = customPath(targets[0]!, 'existing-skill')
    await writeFileWithParents(unmanagedPath, 'external skill')

    const result = await service.createCustomSkill({
      expectedRevision: 0,
      name: 'existing-skill',
      description: 'Must remain external',
      markdown: '# Managed attempt',
      enabled: true,
    })

    expect(result).toMatchObject({ ok: false, code: 'target-conflict' })
    expect((await service.getCustomSkillsSnapshot()).skills).toEqual([])
    expect(await readFile(unmanagedPath, 'utf8')).toBe('external skill')
    await expect(stat(customPath(targets[1]!, 'existing-skill'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('updates one skill without rewriting another skill artifact', async () => {
    const { targets, service } = await harness()
    const firstResult = await service.createCustomSkill({
      expectedRevision: 0,
      name: 'first-skill',
      description: 'First',
      markdown: '# First',
      enabled: true,
    })
    if (!firstResult.ok) throw new Error('first create failed')
    const secondResult = await service.createCustomSkill({
      expectedRevision: firstResult.snapshot.revision,
      name: 'second-skill',
      description: 'Second',
      markdown: '# Second',
      enabled: true,
    })
    if (!secondResult.ok) throw new Error('second create failed')
    const first = secondResult.snapshot.skills.find(skill => skill.name === 'first-skill')!
    const secondPath = customPath(targets[0]!, 'second-skill')
    const before = await stat(secondPath)

    const updated = await service.updateCustomSkill({
      expectedRevision: secondResult.snapshot.revision,
      skillId: first.id,
      description: 'First, revised',
      markdown: '# First revised',
      enabled: true,
    })

    expect(updated).toMatchObject({ ok: true })
    expect((await stat(secondPath)).mtimeMs).toBe(before.mtimeMs)
    expect(await readFile(secondPath, 'utf8')).toContain('# Second')
  })

  it('preserves an externally modified copy and requires fingerprint-bound abandonment to delete', async () => {
    const { targets, service } = await harness()
    const created = await service.createCustomSkill({
      expectedRevision: 0,
      name: 'safe-delete',
      description: 'Exercise ownership-safe deletion',
      markdown: '# Safe delete',
      enabled: true,
    })
    if (!created.ok) throw new Error('create failed')
    const skill = created.snapshot.skills[0]!
    const modifiedPath = customPath(targets[0]!, skill.name)
    await writeFile(modifiedPath, 'external edit')

    const blocked = await service.deleteCustomSkill({
      expectedRevision: created.snapshot.revision,
      skillId: skill.id,
    })
    expect(blocked).toMatchObject({ ok: false, code: 'delete-blocked' })
    if (blocked.ok || blocked.code !== 'delete-blocked') throw new Error('expected blocked delete')
    const conflict = blocked.targets.find(item => item.state === 'conflict')!

    const deleted = await service.deleteCustomSkill({
      expectedRevision: blocked.snapshot.revision,
      skillId: skill.id,
      abandonTargets: [{
        targetId: conflict.id,
        expectedConflictFingerprint: conflict.conflictFingerprint!,
      }],
    })
    expect(deleted).toMatchObject({ ok: true, snapshot: { skills: [] } })
    expect(await readFile(modifiedPath, 'utf8')).toBe('external edit')
    await expect(stat(customPath(targets[1]!, skill.name))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps custom artifacts active when Conventions is disabled', async () => {
    const { targets, service } = await harness()
    const created = await service.createCustomSkill({
      expectedRevision: 0,
      name: 'independent-skill',
      description: 'Must survive conventions changes',
      markdown: '# Independent',
      enabled: true,
    })
    if (!created.ok) throw new Error('create failed')
    await service.save({
      expectedRevision: created.snapshot.revision,
      enabled: true,
      markdown: '# Conventions',
    })
    await service.disable(created.snapshot.revision + 1)

    expect(await readFile(customPath(targets[0]!, 'independent-skill'), 'utf8')).toContain('# Independent')
    expect(await service.getCustomSkillsSnapshot()).toMatchObject({ skills: [{ health: 'active' }] })
  })

  it('adopts crash-published bytes only when the shared journal proves ownership', async () => {
    const root = await temporaryDirectory()
    const currentTarget = target('agents-standard', join(root, '.agents', 'skills'))
    const stateFilePath = join(root, 'state', 'conventions.json')
    const timestamp = '2026-08-26T00:00:00.000Z'
    const skill: AgentCodeCustomSkillRecord = {
      id: 'skill-crash',
      name: 'crash-recovery',
      description: 'Recover a published skill after process loss',
      markdown: '# Recover',
      enabled: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    const rendered = renderAgentCodeCustomSkill(skill)
    const skillPath = customPath(currentTarget, skill.name)
    await writeFileWithParents(skillPath, rendered)
    const key = customArtifactKey(skill.id, currentTarget.id)
    const document = createEmptyAgentCodeConventionsDocument()
    document.customSkills[skill.id] = skill
    document.pendingOperations[key] = {
      operationId: 'crashed-write',
      skillId: skill.id,
      targetId: currentTarget.id,
      path: skillPath,
      kind: 'write',
      previousSha256: null,
      desiredSha256: sha256Text(rendered),
    }
    await writeFileWithParents(stateFilePath, `${JSON.stringify(document)}\n`)

    const service = new AgentCodeConventionsService({
      stateFilePath,
      homeDirectory: root,
      resolveTargets: async () => ({ targets: [currentTarget], unsupportedProviders: [] }),
    })
    await service.initialize()

    expect(await service.getCustomSkillsSnapshot()).toMatchObject({
      skills: [{ name: 'crash-recovery', health: 'active', targets: [{ state: 'installed' }] }],
    })
  })

  it('installs a moved provider root while preserving the historical custom copy', async () => {
    const root = await temporaryDirectory()
    const stateFilePath = join(root, 'state', 'conventions.json')
    const oldTarget = target('agents-standard', join(root, 'old', 'skills'))
    const newTarget = target('agents-standard', join(root, 'new', 'skills'))
    const original = new AgentCodeConventionsService({
      stateFilePath,
      homeDirectory: root,
      resolveTargets: async () => ({ targets: [oldTarget], unsupportedProviders: [] }),
    })
    await original.initialize()
    const created = await original.createCustomSkill({
      expectedRevision: 0,
      name: 'portable-skill',
      description: 'Follow the provider personal-skill root',
      markdown: '# Portable',
      enabled: true,
    })
    expect(created).toMatchObject({ ok: true })

    const restarted = new AgentCodeConventionsService({
      stateFilePath,
      homeDirectory: root,
      resolveTargets: async () => ({ targets: [newTarget], unsupportedProviders: [] }),
    })
    await restarted.initialize()

    expect(await restarted.getCustomSkillsSnapshot()).toMatchObject({
      skills: [{ name: 'portable-skill', health: 'conflict' }],
    })
    expect(await readFile(customPath(oldTarget, 'portable-skill'), 'utf8')).toContain('# Portable')
    expect(await readFile(customPath(newTarget, 'portable-skill'), 'utf8')).toContain('# Portable')
  })

  it('invalidates previously active health when provider target discovery later fails', async () => {
    const root = await temporaryDirectory()
    const currentTarget = target('agents-standard', join(root, '.agents', 'skills'))
    let discoveryFails = false
    const service = new AgentCodeConventionsService({
      stateFilePath: join(root, 'state', 'conventions.json'),
      homeDirectory: root,
      resolveTargets: async () => {
        if (discoveryFails) throw new Error('provider registry unavailable')
        return { targets: [currentTarget], unsupportedProviders: [] }
      },
    })
    await service.initialize()
    const created = await service.createCustomSkill({
      expectedRevision: 0,
      name: 'health-check',
      description: 'Expose discovery failures honestly',
      markdown: '# Health',
      enabled: true,
    })
    expect(created).toMatchObject({ ok: true, snapshot: { skills: [{ health: 'active' }] } })

    discoveryFails = true
    expect(await service.getCustomSkillsSnapshot({ audit: true })).toMatchObject({
      skills: [{ health: 'degraded', targets: [{ state: 'error' }] }],
    })
  })
})
