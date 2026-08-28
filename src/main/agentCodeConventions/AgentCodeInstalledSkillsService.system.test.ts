import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentCodeInstalledSkillFileRecord } from '@shared/types/agentCodeConventions.js'
import type { GitHubSkillDiscoveryPayload, StagedInstalledSkillCandidate } from './githubSkillSource.js'
import { installedSkillManifestDigest } from './installedSkillPackageStore.js'
import { SkillPathSafety } from './skillPathSafety.js'
import type {
  AgentCodeConventionsTarget,
  ResolvedAgentCodeConventionsTargets,
} from './targets.js'
import { AgentCodeConventionsService } from './AgentCodeConventionsService.js'

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'agent-code-installed-service-'))
  temporaryDirectories.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path =>
    rm(path, { recursive: true, force: true })))
})

function target(root: string): AgentCodeConventionsTarget {
  const skillsDirectory = join(root, '.agents', 'skills')
  const skillDirectory = join(skillsDirectory, 'agent-code-conventions')
  return {
    id: 'agents-standard-personal-skills',
    providers: ['codex'],
    providerNames: ['Codex'],
    skillsDirectory,
    skillDirectory,
    skillFile: join(skillDirectory, 'SKILL.md'),
  }
}

function stagedPackage(input: {
  commit: string
  files: Array<{ path: string; content: string | Buffer; executable?: boolean }>
}): StagedInstalledSkillCandidate {
  const contents = new Map<string, Buffer>()
  const files: AgentCodeInstalledSkillFileRecord[] = input.files.map(file => {
    const content = typeof file.content === 'string' ? Buffer.from(file.content) : file.content
    contents.set(file.path, content)
    return {
      path: file.path,
      bytes: content.byteLength,
      sha256: createHash('sha256').update(content).digest('hex'),
      executable: file.executable ?? false,
    }
  }).sort((left, right) => left.path === right.path ? 0 : left.path < right.path ? -1 : 1)
  const snapshotDigest = installedSkillManifestDigest(files)
  return {
    snapshotDigest,
    contents,
    candidate: {
      candidateId: createHash('sha256').update(`${input.commit}\0${snapshotDigest}`).digest('hex').slice(0, 32),
      name: 'review-code',
      description: 'Review code and explain consequential findings.',
      source: {
        owner: 'example',
        repository: 'skills',
        repositoryUrl: 'https://github.com/example/skills',
        requestedRef: 'main',
        requestedRefType: 'branch',
        path: 'skills/review-code',
        skillUrl: 'https://github.com/example/skills/tree/main/skills/review-code',
        resolvedCommit: input.commit,
      },
      files,
      totalBytes: files.reduce((total, file) => total + file.bytes, 0),
      warnings: [],
    },
  }
}

function payload(candidate: StagedInstalledSkillCandidate): GitHubSkillDiscoveryPayload {
  return {
    repositoryUrl: candidate.candidate.source.repositoryUrl,
    requestedRef: candidate.candidate.source.requestedRef,
    requestedRefType: candidate.candidate.source.requestedRefType,
    resolvedCommit: candidate.candidate.source.resolvedCommit,
    candidates: [candidate],
    notices: [],
  }
}

async function harness(options: { now?: () => Date; snapshotMaxBytes?: number } = {}) {
  const root = await temporaryDirectory()
  const currentTarget = target(root)
  const discoveries: GitHubSkillDiscoveryPayload[] = []
  const githubSkillSource = {
    discover: vi.fn(async () => {
      const next = discoveries.shift()
      if (!next) throw new Error('No staged test discovery')
      return next
    }),
  }
  const resolved: ResolvedAgentCodeConventionsTargets = {
    targets: [currentTarget],
    unsupportedProviders: [],
  }
  const pathSafety = new SkillPathSafety(root)
  const service = new AgentCodeConventionsService({
    stateFilePath: join(root, 'state', 'conventions.json'),
    installedSkillSnapshotRoot: join(root, 'state', 'managed-skill-snapshots'),
    installedSkillSnapshotMaxBytes: options.snapshotMaxBytes,
    homeDirectory: root,
    resolveTargets: async () => resolved,
    githubSkillSource,
    now: options.now ?? (() => new Date('2026-08-27T00:00:00.000Z')),
    operationId: (() => { let value = 0; return () => `installed-operation-${++value}` })(),
    pathSafety,
  })
  await service.initialize()
  return {
    root,
    service,
    discoveries,
    pathSafety,
    skillDirectory: join(currentTarget.skillsDirectory, 'review-code'),
  }
}

async function discoverOne(
  service: AgentCodeConventionsService,
  discoveries: GitHubSkillDiscoveryPayload[],
  candidate: StagedInstalledSkillCandidate,
) {
  discoveries.push(payload(candidate))
  const result = await service.discoverGitHubSkills(candidate.candidate.source.skillUrl)
  if (!result.ok) throw new Error(result.message)
  return result.discovery
}

describe('AgentCode installed skills service', () => {
  it('installs a reviewed package and requires a second review before updating it', async () => {
    const { root, service, discoveries, skillDirectory } = await harness()
    const first = stagedPackage({
      commit: 'a'.repeat(40),
      files: [
        { path: 'SKILL.md', content: 'first instructions' },
        { path: 'assets/rules.bin', content: Buffer.from([0, 1, 2, 255]) },
      ],
    })
    const discovery = await discoverOne(service, discoveries, first)
    const installed = await service.installGitHubSkills({
      expectedRevision: 0,
      discoveryId: discovery.discoveryId,
      candidateIds: [first.candidate.candidateId],
    })
    expect(installed).toMatchObject({
      ok: true,
      snapshot: { revision: 1, skills: [{ name: 'review-code', health: 'active' }] },
    })
    if (!installed.ok) throw new Error('installation failed')
    const skillId = installed.snapshot.skills[0]!.id
    expect(await readFile(join(skillDirectory, 'assets', 'rules.bin')))
      .toEqual(Buffer.from([0, 1, 2, 255]))

    const disabled = await service.setInstalledSkillEnabled({
      expectedRevision: 1,
      skillId,
      enabled: false,
    })
    expect(disabled).toMatchObject({ ok: true, snapshot: { revision: 2, skills: [{ health: 'disabled' }] } })
    await expect(stat(join(skillDirectory, 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' })

    const enabled = await service.setInstalledSkillEnabled({
      expectedRevision: 2,
      skillId,
      enabled: true,
    })
    expect(enabled).toMatchObject({ ok: true, snapshot: { revision: 3, skills: [{ health: 'active' }] } })

    const second = stagedPackage({
      commit: 'b'.repeat(40),
      files: [
        { path: 'SKILL.md', content: 'second instructions' },
        { path: 'scripts/check.sh', content: '#!/bin/sh\nexit 0\n', executable: true },
      ],
    })
    discoveries.push(payload(second))
    const update = await service.checkInstalledSkillForUpdates(
      skillId,
    )
    expect(update).toMatchObject({
      ok: true,
      kind: 'update-available',
      changes: {
        added: ['scripts/check.sh'],
        changed: ['SKILL.md'],
        removed: ['assets/rules.bin'],
      },
    })
    expect(await readFile(join(skillDirectory, 'SKILL.md'), 'utf8')).toBe('first instructions')
    if (!update.ok || update.kind !== 'update-available') throw new Error('expected reviewed update')

    const applied = await service.applyInstalledSkillUpdate({
      expectedRevision: 3,
      skillId,
      discoveryId: update.discovery.discoveryId,
      candidateId: update.candidate.candidateId,
    })
    expect(applied).toMatchObject({
      ok: true,
      snapshot: {
        revision: 4,
        skills: [{ source: { resolvedCommit: 'b'.repeat(40) }, health: 'active' }],
      },
    })
    expect(await readFile(join(skillDirectory, 'SKILL.md'), 'utf8')).toBe('second instructions')
    expect((await stat(join(skillDirectory, 'scripts', 'check.sh'))).mode & 0o111).not.toBe(0)
    // Immutable snapshots are intentionally retained: Node cannot recursively
    // delete relative to an opened directory handle on every supported host,
    // so automatic GC could be redirected by an ancestor-symlink race.
    await expect(stat(join(root, 'state', 'managed-skill-snapshots', first.snapshotDigest)))
      .resolves.toMatchObject({})

    const removed = await service.deleteInstalledSkill({
      expectedRevision: 4,
      skillId,
    })
    expect(removed).toMatchObject({ ok: true, snapshot: { skills: [] } })
    await expect(stat(join(skillDirectory, 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('bounds retained source snapshots before admitting another package', async () => {
    const { root, service, discoveries } = await harness({ snapshotMaxBytes: 30 })
    const first = stagedPackage({
      commit: 'a'.repeat(40),
      files: [{ path: 'SKILL.md', content: 'first instructions' }],
    })
    const firstDiscovery = await discoverOne(service, discoveries, first)
    const installed = await service.installGitHubSkills({
      expectedRevision: 0,
      discoveryId: firstDiscovery.discoveryId,
      candidateIds: [first.candidate.candidateId],
    })
    if (!installed.ok) throw new Error('installation failed')
    const skillId = installed.snapshot.skills[0]!.id
    const removed = await service.deleteInstalledSkill({
      expectedRevision: installed.snapshot.revision,
      skillId,
    })
    expect(removed).toMatchObject({ ok: true, snapshot: { skills: [] } })
    if (!removed.ok) throw new Error('removal failed')

    const second = stagedPackage({
      commit: 'b'.repeat(40),
      files: [{ path: 'SKILL.md', content: 'second instructions' }],
    })
    const secondDiscovery = await discoverOne(service, discoveries, second)
    expect(await service.installGitHubSkills({
      expectedRevision: removed.snapshot.revision,
      discoveryId: secondDiscovery.discoveryId,
      candidateIds: [second.candidate.candidateId],
    })).toMatchObject({ ok: false, code: 'io-error', message: expect.stringMatching(/safety limit/) })
    expect((await service.getInstalledSkillsSnapshot()).skills).toEqual([])
    await expect(stat(join(root, 'state', 'managed-skill-snapshots', first.snapshotDigest)))
      .resolves.toMatchObject({})
    await expect(stat(join(root, 'state', 'managed-skill-snapshots', second.snapshotDigest)))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('retains ownership and retry authority when provider-file removal fails', async () => {
    const { root, service, discoveries, pathSafety, skillDirectory } = await harness()
    const candidate = stagedPackage({
      commit: 'a'.repeat(40),
      files: [{ path: 'SKILL.md', content: 'managed instructions' }],
    })
    const discovery = await discoverOne(service, discoveries, candidate)
    const installed = await service.installGitHubSkills({
      expectedRevision: 0,
      discoveryId: discovery.discoveryId,
      candidateIds: [candidate.candidate.candidateId],
    })
    if (!installed.ok) throw new Error('installation failed')
    const skillId = installed.snapshot.skills[0]!.id
    vi.spyOn(pathSafety, 'unlinkOwnedRegularFile').mockRejectedValueOnce(
      Object.assign(new Error('permission denied'), { code: 'EACCES' }),
    )

    const blocked = await service.deleteInstalledSkill({ expectedRevision: 1, skillId })

    expect(blocked).toMatchObject({
      ok: false,
      code: 'delete-blocked',
      snapshot: { skills: [{ id: skillId, enabled: false, health: 'degraded' }] },
      targets: [{ state: 'error' }],
    })
    if (blocked.ok || blocked.code !== 'delete-blocked') {
      throw new Error('expected removal to remain blocked')
    }
    expect(await readFile(join(skillDirectory, 'SKILL.md'), 'utf8')).toBe('managed instructions')
    const persisted = JSON.parse(await readFile(join(root, 'state', 'conventions.json'), 'utf8')) as {
      installedSkills: Record<string, unknown>
      installedMaterializations: Record<string, unknown>
      installedPendingOperations: Record<string, unknown>
    }
    expect(persisted.installedSkills).toHaveProperty(skillId)
    expect(Object.keys(persisted.installedMaterializations)).toHaveLength(1)
    expect(Object.keys(persisted.installedPendingOperations)).toHaveLength(1)

    const retried = await service.deleteInstalledSkill({
      expectedRevision: blocked.snapshot.revision,
      skillId,
    })
    expect(retried).toMatchObject({ ok: true, snapshot: { skills: [] } })
    await expect(stat(join(skillDirectory, 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('expires staged review authority before any state or provider mutation', async () => {
    let now = new Date('2026-08-27T00:00:00.000Z')
    const { service, discoveries, skillDirectory } = await harness({ now: () => now })
    const candidate = stagedPackage({
      commit: 'a'.repeat(40),
      files: [{ path: 'SKILL.md', content: 'reviewed instructions' }],
    })
    const discovery = await discoverOne(service, discoveries, candidate)
    now = new Date('2026-08-27T00:16:00.000Z')

    expect(await service.installGitHubSkills({
      expectedRevision: 0,
      discoveryId: discovery.discoveryId,
      candidateIds: [candidate.candidate.candidateId],
    })).toMatchObject({ ok: false, code: 'expired' })
    expect((await service.getInstalledSkillsSnapshot()).skills).toEqual([])
    await expect(stat(skillDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses unmanaged destinations without caching or overwriting the reviewed package', async () => {
    const { root, service, discoveries, skillDirectory } = await harness()
    await mkdir(skillDirectory, { recursive: true })
    await writeFile(join(skillDirectory, 'SKILL.md'), 'unmanaged instructions')
    const candidate = stagedPackage({
      commit: 'a'.repeat(40),
      files: [{ path: 'SKILL.md', content: 'reviewed instructions' }],
    })
    const discovery = await discoverOne(service, discoveries, candidate)

    expect(await service.installGitHubSkills({
      expectedRevision: 0,
      discoveryId: discovery.discoveryId,
      candidateIds: [candidate.candidate.candidateId],
    })).toMatchObject({ ok: false, code: 'target-conflict' })
    expect(await readFile(join(skillDirectory, 'SKILL.md'), 'utf8')).toBe('unmanaged instructions')
    await expect(stat(join(root, 'state', 'managed-skill-snapshots')))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves externally edited packages until the user explicitly abandons ownership', async () => {
    const { service, discoveries, skillDirectory } = await harness()
    const candidate = stagedPackage({
      commit: 'a'.repeat(40),
      files: [{ path: 'SKILL.md', content: 'managed instructions' }],
    })
    const discovery = await discoverOne(service, discoveries, candidate)
    const installed = await service.installGitHubSkills({
      expectedRevision: 0,
      discoveryId: discovery.discoveryId,
      candidateIds: [candidate.candidate.candidateId],
    })
    if (!installed.ok) throw new Error('installation failed')
    const skillId = installed.snapshot.skills[0]!.id
    await writeFile(join(skillDirectory, 'SKILL.md'), 'external edit')

    const blocked = await service.deleteInstalledSkill({ expectedRevision: 1, skillId })
    expect(blocked).toMatchObject({ ok: false, code: 'delete-blocked' })
    if (blocked.ok || blocked.code !== 'delete-blocked') throw new Error('expected blocked removal')
    const conflict = blocked.targets.find(value => value.state === 'conflict')
    expect(conflict?.conflictFingerprint).toBeTruthy()

    const forgotten = await service.deleteInstalledSkill({
      expectedRevision: blocked.snapshot.revision,
      skillId,
      abandonTargets: [{
        targetId: conflict!.id,
        expectedConflictFingerprint: conflict!.conflictFingerprint!,
      }],
    })
    expect(forgotten).toMatchObject({ ok: true, snapshot: { skills: [] } })
    expect(await readFile(join(skillDirectory, 'SKILL.md'), 'utf8')).toBe('external edit')
  })
})
