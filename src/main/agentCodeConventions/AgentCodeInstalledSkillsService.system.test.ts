import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentCodeInstalledSkillFileRecord } from '@shared/types/agentCodeConventions.js'
import type {
  GitHubSkillDiscoveryPayload,
  ReviewedInstalledSkillCandidate,
  StagedInstalledSkillCandidate,
} from './githubSkillSource.js'
import { InstalledSkillPackageStore, installedSkillManifestDigest } from './installedSkillPackageStore.js'
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
  name?: string
}): StagedInstalledSkillCandidate {
  const name = input.name ?? 'review-code'
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
      candidateId: createHash('sha256').update(`${input.commit}\0${name}\0${snapshotDigest}`).digest('hex').slice(0, 32),
      name,
      description: 'Review code and explain consequential findings.',
      source: {
        owner: 'example',
        repository: 'skills',
        repositoryUrl: 'https://github.com/example/skills',
        requestedRef: 'main',
        requestedRefType: 'branch',
        path: `skills/${name}`,
        skillUrl: `https://github.com/example/skills/tree/main/skills/${name}`,
        resolvedCommit: input.commit,
      },
      files,
      totalBytes: files.reduce((total, file) => total + file.bytes, 0),
      warnings: [],
    },
  }
}

// The service only reads `candidate` from a reviewed package and hands the
// whole object back to `acquire`; the tree-level fields belong to
// githubSkillSource and are covered by its own tests. The test source's
// `acquire` returns the fully staged package the review stands for.
type TestReviewed = ReviewedInstalledSkillCandidate & { acquired: StagedInstalledSkillCandidate }

function reviewedFrom(candidate: StagedInstalledSkillCandidate): TestReviewed {
  return {
    candidate: candidate.candidate,
    owner: candidate.candidate.source.owner,
    repository: candidate.candidate.source.repository,
    commit: candidate.candidate.source.resolvedCommit,
    entries: [],
    skillMarkdown: Buffer.alloc(0),
    acquired: candidate,
  }
}

function payload(...candidates: StagedInstalledSkillCandidate[]): GitHubSkillDiscoveryPayload {
  const first = candidates[0]!
  return {
    repositoryUrl: first.candidate.source.repositoryUrl,
    requestedRef: first.candidate.source.requestedRef,
    requestedRefType: first.candidate.source.requestedRefType,
    resolvedCommit: first.candidate.source.resolvedCommit,
    candidates: candidates.map(reviewedFrom),
    notices: [],
    missingSkills: [],
  }
}

async function harness(
  options: {
    now?: () => Date
    unsupportedProviders?: ResolvedAgentCodeConventionsTargets['unsupportedProviders']
    /** Flip `.fail` to make provider target discovery throw from then on. */
    discovery?: { fail: boolean }
    /** Also resolve a Claude root (shared with OpenCode, like the real registry). */
    claudeRoot?: boolean
  } = {},
) {
  const root = await temporaryDirectory()
  const currentTarget = target(root)
  const claude = claudeTarget(root)
  const discoveries: GitHubSkillDiscoveryPayload[] = []
  const githubSkillSource = {
    discover: vi.fn(async () => {
      const next = discoveries.shift()
      if (!next) throw new Error('No staged test discovery')
      return next
    }),
    acquire: vi.fn(async (reviewed: ReviewedInstalledSkillCandidate) => (reviewed as TestReviewed).acquired),
  }
  const resolved: ResolvedAgentCodeConventionsTargets = {
    targets: options.claudeRoot ? [currentTarget, claude] : [currentTarget],
    unsupportedProviders: options.unsupportedProviders ?? [],
  }
  const pathSafety = new SkillPathSafety(root)
  const service = new AgentCodeConventionsService({
    stateFilePath: join(root, 'state', 'conventions.json'),
    homeDirectory: root,
    resolveTargets: async () => {
      if (options.discovery?.fail) throw new Error('Could not read provider configuration')
      return resolved
    },
    githubSkillSource,
    now: options.now ?? (() => new Date('2026-08-27T00:00:00.000Z')),
    operationId: (() => { let value = 0; return () => `installed-operation-${++value}` })(),
    pathSafety,
  })
  await service.initialize()
  return {
    root,
    service,
    githubSkillSource,
    discoveries,
    pathSafety,
    skillDirectory: join(currentTarget.skillsDirectory, 'review-code'),
    claudeSkillDirectory: join(claude.skillsDirectory, 'review-code'),
  }
}

function claudeTarget(root: string): AgentCodeConventionsTarget {
  const skillsDirectory = join(root, '.claude', 'skills')
  const skillDirectory = join(skillsDirectory, 'agent-code-conventions')
  return {
    id: 'claude-personal-skills',
    providers: ['claude', 'opencode'],
    providerNames: ['Claude', 'OpenCode'],
    skillsDirectory,
    skillDirectory,
    skillFile: join(skillDirectory, 'SKILL.md'),
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
  // Regression for #1014: an unsupported registered provider (grok) must not
  // block installing GitHub skills for the providers that do support them.
  it('installs and reports active with an unsupported provider present', async () => {
    const { service, discoveries } = await harness({ unsupportedProviders: ['grok'] })
    const staged = stagedPackage({
      commit: 'a'.repeat(40),
      files: [{ path: 'SKILL.md', content: '# Review code' }],
    })
    const discovery = await discoverOne(service, discoveries, staged)
    const installed = await service.installGitHubSkills({
      expectedRevision: 0,
      discoveryId: discovery.discoveryId,
      candidateIds: [staged.candidate.candidateId],
    })
    expect(installed).toMatchObject({
      ok: true,
      snapshot: { skills: [{ name: 'review-code', health: 'active' }] },
    })
    const snapshot = await service.getInstalledSkillsSnapshot()
    const skill = snapshot.skills.find(item => item.name === 'review-code')
    expect(skill?.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'unsupported:grok', state: 'unsupported' }),
    ]))
    expect(snapshot.unsupportedProviders).toEqual(['grok'])
  })

  // #1017 review: when provider target discovery fails, the conventions
  // and custom skills report 'degraded' with the error row, but an installed
  // skill kept its stale rows, and with zero resolved targets its health
  // read 'unsupported', which says "no provider can take this" when the
  // truth is "we could not look".
  it('reports an installed skill as degraded, with the error, when target discovery fails', async () => {
    const discovery = { fail: false }
    const { service, discoveries } = await harness({ discovery })
    const staged = stagedPackage({ commit: 'a'.repeat(40), files: [{ path: 'SKILL.md', content: '# Review code' }] })
    const found = await discoverOne(service, discoveries, staged)
    await service.installGitHubSkills({ expectedRevision: 0, discoveryId: found.discoveryId, candidateIds: [staged.candidate.candidateId] })
    discovery.fail = true
    await service.audit()
    const skill = (await service.getInstalledSkillsSnapshot()).skills.find(item => item.name === 'review-code')
    expect(skill?.health).toBe('degraded')
    expect(skill?.targets).toEqual([expect.objectContaining({ id: 'provider-target-resolution', state: 'error' })])
  })

  it('a disabled skill can still be deleted while target discovery is failing', async () => {
    // #1037 review: the discovery-error row has no fingerprint, so as a
    // delete blocker it could never be approved, and delete dead-ended with
    // "External changes must be reviewed".
    const discovery = { fail: false }
    const { service, discoveries } = await harness({ discovery })
    const staged = stagedPackage({ commit: 'a'.repeat(40), files: [{ path: 'SKILL.md', content: '# Review code' }] })
    const found = await discoverOne(service, discoveries, staged)
    const installed = await service.installGitHubSkills({ expectedRevision: 0, discoveryId: found.discoveryId, candidateIds: [staged.candidate.candidateId] })
    if (!installed.ok) throw new Error(JSON.stringify(installed))
    const skill = installed.snapshot.skills.find(item => item.name === 'review-code')!
    const disabled = await service.setInstalledSkillEnabled({ expectedRevision: installed.snapshot.revision, skillId: skill.id, enabled: false })
    if (!disabled.ok) throw new Error(JSON.stringify(disabled))
    discovery.fail = true
    await service.audit()
    const deleted = await service.deleteInstalledSkill({ expectedRevision: disabled.snapshot.revision, skillId: skill.id })
    expect(deleted).toMatchObject({ ok: true })
  })

  it('installs a reviewed package and requires a second review before updating it', async () => {
    const { root, service, githubSkillSource, discoveries, skillDirectory } = await harness()
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
    // Review round 1: the check names the skill, so an internal skill
    // (hidden from browsing) is still found, on the exact recorded ref/path.
    expect(githubSkillSource.discover).toHaveBeenLastCalledWith({
      source: { owner: 'example', repository: 'skills', ref: 'main', subpath: 'skills/review-code' },
      skills: ['review-code'],
    })
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
    // #1161: the superseded snapshot is removed once nothing references it
    // (content-proven, non-recursive cleanup; see installedSkillPackageStore).
    await expect(stat(join(root, 'state', 'managed-skill-snapshots', first.snapshotDigest)))
      .rejects.toMatchObject({ code: 'ENOENT' })

    const removed = await service.deleteInstalledSkill({
      expectedRevision: 4,
      skillId,
    })
    expect(removed).toMatchObject({ ok: true, snapshot: { skills: [] } })
    await expect(stat(join(skillDirectory, 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  // #1161: the former cap of 25 refused the 26th install AND sent a larger
  // document into Recovery required on load. Neither may happen now.
  it('installs more than 25 skills and reloads them without recovery', async () => {
    const { root, service, discoveries } = await harness()
    const packages = Array.from({ length: 30 }, (_, index) => stagedPackage({
      commit: 'a'.repeat(40),
      name: `skill-${index}`,
      files: [{ path: 'SKILL.md', content: `instructions ${index}` }],
    }))
    discoveries.push(payload(...packages))
    const found = await service.discoverGitHubSkills('npx skills add example/skills --all')
    if (!found.ok) throw new Error(found.message)
    const installed = await service.installGitHubSkills({
      expectedRevision: 0,
      discoveryId: found.discovery.discoveryId,
      candidateIds: found.discovery.candidates.map(candidate => candidate.candidateId),
    })
    expect(installed).toMatchObject({ ok: true })
    if (!installed.ok) throw new Error('installation failed')
    expect(installed.snapshot.skills).toHaveLength(30)

    const reloaded = new AgentCodeConventionsService({
      stateFilePath: join(root, 'state', 'conventions.json'),
        homeDirectory: root,
      resolveTargets: async () => ({ targets: [target(root)], unsupportedProviders: [] }),
    })
    await reloaded.initialize()
    const snapshot = await reloaded.getInstalledSkillsSnapshot()
    expect(snapshot.recovery).toBeUndefined()
    expect(snapshot.skills).toHaveLength(30)
  })

  // #1161: snapshots were retained forever behind a 256 MiB stop that became
  // a hidden skills cap. Removing a skill now removes its snapshot.
  it('deletes the source snapshot of a removed skill', async () => {
    const { root, service, discoveries } = await harness()
    const staged = stagedPackage({
      commit: 'a'.repeat(40),
      files: [
        { path: 'SKILL.md', content: 'first instructions' },
        { path: 'scripts/run.sh', content: 'echo hi', executable: true },
      ],
    })
    const found = await discoverOne(service, discoveries, staged)
    const installed = await service.installGitHubSkills({
      expectedRevision: 0,
      discoveryId: found.discoveryId,
      candidateIds: [staged.candidate.candidateId],
    })
    if (!installed.ok) throw new Error('installation failed')
    const snapshotDirectory = join(root, 'state', 'managed-skill-snapshots', staged.snapshotDigest)
    await expect(stat(snapshotDirectory)).resolves.toMatchObject({})
    const removed = await service.deleteInstalledSkill({
      expectedRevision: installed.snapshot.revision,
      skillId: installed.snapshot.skills[0]!.id,
    })
    expect(removed).toMatchObject({ ok: true, snapshot: { skills: [] } })
    await expect(stat(snapshotDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(join(root, 'state', 'managed-skill-snapshots'))).toEqual([])
  })

  it('sweeps unreferenced snapshots at startup but never a tampered one or a staging leftover', async () => {
    const { root } = await harness()
    const snapshots = join(root, 'state', 'managed-skill-snapshots')
    const orphan = stagedPackage({ commit: 'a'.repeat(40), files: [{ path: 'SKILL.md', content: 'orphan' }] })
    const tampered = stagedPackage({ commit: 'b'.repeat(40), files: [{ path: 'SKILL.md', content: 'original' }] })
    const store = new InstalledSkillPackageStore(snapshots)
    await store.store(orphan)
    await store.store(tampered)
    await writeFile(join(snapshots, tampered.snapshotDigest, 'SKILL.md'), 'changed by someone else')
    await mkdir(join(snapshots, '.staging-leftover'))

    const service = new AgentCodeConventionsService({
      stateFilePath: join(root, 'state', 'conventions.json'),
      homeDirectory: root,
      resolveTargets: async () => ({ targets: [target(root)], unsupportedProviders: [] }),
    })
    await service.initialize()
    const remaining = (await readdir(snapshots)).sort()
    expect(remaining).not.toContain(orphan.snapshotDigest)
    expect(remaining).toContain('.staging-leftover')
    // The tampered snapshot failed its content proof and stays quarantined,
    // inert, with its bytes untouched.
    const quarantined = remaining.find(name => name.startsWith(`.trash-${tampered.snapshotDigest}-`))
    expect(quarantined).toBeDefined()
    expect(await readFile(join(snapshots, quarantined!, 'SKILL.md'), 'utf8')).toBe('changed by someone else')
  })

  // Regression for #1206. Two system test files built the service with a temp
  // `stateFilePath` but no snapshot root (a separate option at the time), so
  // the startup sweep ran their EMPTY journal against the developer's real ~/.config store and deleted every
  // installed skill's snapshot. The contract under test is that a journal only
  // ever sweeps the store beside it. WHY assert through the sweep and not by
  // reading a path getter: the sweep is the destructive consumer that
  // actually broke. If the store is ever resolved anywhere but beside the
  // journal again, the orphan below survives and this fails. Proving it red against
  // the unfixed code must be done with HOME pointed at a scratch directory,
  // because the unfixed code deletes the real store as a side effect.
  it('keeps the snapshot store beside its journal', async () => {
    const root = await temporaryDirectory()
    const stateDirectory = join(root, 'state')
    const orphan = stagedPackage({ commit: 'c'.repeat(40), files: [{ path: 'SKILL.md', content: 'orphan' }] })
    await new InstalledSkillPackageStore(join(stateDirectory, 'managed-skill-snapshots')).store(orphan)

    const service = new AgentCodeConventionsService({
      stateFilePath: join(stateDirectory, 'conventions.json'),
      homeDirectory: root,
      resolveTargets: async () => ({ targets: [target(root)], unsupportedProviders: [] }),
    })
    await service.initialize()

    expect(await readdir(join(stateDirectory, 'managed-skill-snapshots'))).toEqual([])
  })

  // #1206: when a snapshot was gone, every provider row showed the raw
  // `ENOENT: … lstat '<64-hex path>'` errno, which reads like a broken
  // provider folder even though the provider copy is fine and the skill
  // still loads. The row must say which copy is missing.
  // Both shapes seen in practice: the sweep emptied the store (one digest
  // directory gone), and a user clearing ~/.config removes the whole store.
  it.each([
    ['its snapshot directory', (root: string, digest: string) => join(root, 'state', 'managed-skill-snapshots', digest)],
    ['the whole snapshot store', (root: string) => join(root, 'state', 'managed-skill-snapshots')],
  ])('reports a missing reviewed snapshot as missing when %s is gone, not as a raw lstat error', async (_, removed) => {
    const { root, service, discoveries } = await harness()
    const staged = stagedPackage({ commit: 'd'.repeat(40), files: [{ path: 'SKILL.md', content: 'kept' }] })
    const found = await discoverOne(service, discoveries, staged)
    const installed = await service.installGitHubSkills({
      expectedRevision: 0,
      discoveryId: found.discoveryId,
      candidateIds: [staged.candidate.candidateId],
    })
    if (!installed.ok) throw new Error('installation failed')
    await rm(removed(root, staged.snapshotDigest), { recursive: true })

    const reloaded = new AgentCodeConventionsService({
      stateFilePath: join(root, 'state', 'conventions.json'),
      homeDirectory: root,
      resolveTargets: async () => ({ targets: [target(root)], unsupportedProviders: [] }),
    })
    await reloaded.initialize()
    const skill = (await reloaded.getInstalledSkillsSnapshot()).skills[0]!
    expect(skill.health).toBe('degraded')
    const messages = skill.targets.map(item => item.message ?? '')
    expect(messages.length).toBeGreaterThan(0)
    for (const message of messages) {
      expect(message).toMatch(/reviewed copy of this skill is missing/)
      expect(message).not.toMatch(/ENOENT|lstat/)
    }
  })

  // #1161: `-a codex` / the grid's provider columns.
  it('installs for the chosen providers only and moves the copy when the choice changes', async () => {
    const { service, discoveries, skillDirectory, claudeSkillDirectory } = await harness({ claudeRoot: true })
    const staged = stagedPackage({ commit: 'a'.repeat(40), files: [{ path: 'SKILL.md', content: 'codex only' }] })
    discoveries.push(payload(staged))
    const found = await service.discoverGitHubSkills('npx skills add example/skills --skill review-code -a codex')
    if (!found.ok) throw new Error(found.message)
    expect(found.discovery.selection).toMatchObject({ skills: ['review-code'], providers: ['codex'] })
    const installed = await service.installGitHubSkills({
      expectedRevision: 0,
      discoveryId: found.discovery.discoveryId,
      candidateIds: [staged.candidate.candidateId],
      providers: ['codex'],
    })
    expect(installed).toMatchObject({ ok: true, snapshot: { skills: [{ providers: ['codex'] }] } })
    if (!installed.ok) throw new Error('install failed')
    await expect(stat(join(skillDirectory, 'SKILL.md'))).resolves.toMatchObject({})
    await expect(stat(join(claudeSkillDirectory, 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' })

    const moved = await service.setInstalledSkillProviders({
      expectedRevision: installed.snapshot.revision,
      skillId: installed.snapshot.skills[0]!.id,
      providers: ['claude'],
    })
    expect(moved).toMatchObject({ ok: true, snapshot: { skills: [{ providers: ['claude'], health: 'active' }] } })
    await expect(stat(join(claudeSkillDirectory, 'SKILL.md'))).resolves.toMatchObject({})
    await expect(stat(join(skillDirectory, 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' })

    if (!moved.ok) throw new Error('move failed')
    const everywhere = await service.setInstalledSkillProviders({
      expectedRevision: moved.snapshot.revision,
      skillId: moved.snapshot.skills[0]!.id,
      providers: null,
    })
    expect(everywhere).toMatchObject({ ok: true })
    if (!everywhere.ok) throw new Error('reset failed')
    expect(everywhere.snapshot.skills[0]!.providers).toBeUndefined()
    await expect(stat(join(skillDirectory, 'SKILL.md'))).resolves.toMatchObject({})
  })

  it('changes nothing when a newly chosen folder already holds an external skill', async () => {
    const { service, discoveries, skillDirectory, claudeSkillDirectory } = await harness({ claudeRoot: true })
    const staged = stagedPackage({ commit: 'a'.repeat(40), files: [{ path: 'SKILL.md', content: 'codex only' }] })
    const found = await discoverOne(service, discoveries, staged)
    const installed = await service.installGitHubSkills({
      expectedRevision: 0,
      discoveryId: found.discoveryId,
      candidateIds: [staged.candidate.candidateId],
      providers: ['codex'],
    })
    if (!installed.ok) throw new Error('install failed')
    await mkdir(claudeSkillDirectory, { recursive: true })
    await writeFile(join(claudeSkillDirectory, 'SKILL.md'), 'someone else')
    const moved = await service.setInstalledSkillProviders({
      expectedRevision: installed.snapshot.revision,
      skillId: installed.snapshot.skills[0]!.id,
      providers: ['claude'],
    })
    expect(moved).toMatchObject({ ok: false, code: 'target-conflict' })
    expect((await service.getInstalledSkillsSnapshot()).skills[0]!.providers).toEqual(['codex'])
    expect(await readFile(join(claudeSkillDirectory, 'SKILL.md'), 'utf8')).toBe('someone else')
    await expect(stat(join(skillDirectory, 'SKILL.md'))).resolves.toMatchObject({})
  })

  it('keeps a proposal from an agent disabled, pending review, and off provider roots', async () => {
    const { service, discoveries, skillDirectory } = await harness()
    const staged = stagedPackage({ commit: 'a'.repeat(40), files: [{ path: 'SKILL.md', content: 'proposal' }] })
    const found = await discoverOne(service, discoveries, staged)
    const proposed = await service.installGitHubSkills({
      expectedRevision: 0,
      discoveryId: found.discoveryId,
      candidateIds: [staged.candidate.candidateId],
    }, { pendingReview: { by: 'agent', sessionId: 'session-1', requestedAt: '2026-09-23T00:00:00.000Z' } })
    expect(proposed).toMatchObject({
      ok: true,
      snapshot: { skills: [{ enabled: false, pendingReview: { by: 'agent', sessionId: 'session-1' } }] },
    })
    await expect(stat(skillDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
    if (!proposed.ok) throw new Error('proposal failed')
    const enabled = await service.setInstalledSkillEnabled({
      expectedRevision: proposed.snapshot.revision,
      skillId: proposed.snapshot.skills[0]!.id,
      enabled: true,
    })
    expect(enabled).toMatchObject({ ok: true, snapshot: { skills: [{ enabled: true }] } })
    if (!enabled.ok) throw new Error('enable failed')
    // The user's enable is the review; the marker must not survive it.
    expect(enabled.snapshot.skills[0]!.pendingReview).toBeUndefined()
    await expect(stat(join(skillDirectory, 'SKILL.md'))).resolves.toMatchObject({})
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
