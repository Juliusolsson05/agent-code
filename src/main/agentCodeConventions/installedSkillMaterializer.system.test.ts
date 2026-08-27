import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { AgentCodeInstalledSkillFileRecord } from '@shared/types/agentCodeConventions.js'
import type { AgentCodeInstalledSkillCandidate } from '@shared/types/agentCodeInstalledSkills.js'
import type { StagedInstalledSkillCandidate } from './githubSkillSource.js'
import { InstalledSkillMaterializer } from './installedSkillMaterializer.js'
import {
  InstalledSkillPackageStore,
  installedSkillManifestDigest,
} from './installedSkillPackageStore.js'
import { SkillPathSafety } from './skillPathSafety.js'
import type { AgentCodeConventionsTarget } from './targets.js'

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'agent-code-installed-materializer-'))
  temporaryDirectories.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function staged(files: Array<{ path: string; content: Buffer | string; executable?: boolean }>): StagedInstalledSkillCandidate {
  const contents = new Map<string, Buffer>()
  const manifest: AgentCodeInstalledSkillFileRecord[] = files
    .map(file => {
      const content = typeof file.content === 'string' ? Buffer.from(file.content) : file.content
      contents.set(file.path, content)
      return {
        path: file.path,
        bytes: content.byteLength,
        sha256: createHash('sha256').update(content).digest('hex'),
        executable: file.executable ?? false,
      }
    })
    .sort((left, right) => left.path === right.path ? 0 : left.path < right.path ? -1 : 1)
  const snapshotDigest = installedSkillManifestDigest(manifest)
  const candidate: AgentCodeInstalledSkillCandidate = {
    candidateId: snapshotDigest.slice(0, 32),
    name: 'review-code',
    description: 'Review code.',
    source: {
      owner: 'example',
      repository: 'skills',
      repositoryUrl: 'https://github.com/example/skills',
      requestedRef: 'main',
      requestedRefType: 'branch',
      path: 'skills/review-code',
      skillUrl: 'https://github.com/example/skills/tree/main/skills/review-code',
      resolvedCommit: 'a'.repeat(40),
    },
    files: manifest,
    totalBytes: manifest.reduce((total, file) => total + file.bytes, 0),
    warnings: [],
  }
  return { candidate, snapshotDigest, contents }
}

function target(home: string): AgentCodeConventionsTarget {
  const skillsDirectory = join(home, '.agents', 'skills')
  const skillDirectory = join(skillsDirectory, 'review-code')
  return {
    id: 'agents-standard',
    providers: ['codex'],
    providerNames: ['Codex'],
    skillsDirectory,
    skillDirectory,
    skillFile: join(skillDirectory, 'SKILL.md'),
  }
}

describe('installed skill package materialization', () => {
  it('publishes, updates, and removes a multi-file binary package from immutable snapshots', async () => {
    const home = await temporaryDirectory()
    const store = new InstalledSkillPackageStore(join(home, 'snapshots'))
    const materializer = new InstalledSkillMaterializer(new SkillPathSafety(home), store)
    // This asset deliberately exceeds the much smaller conventions-file
    // collision limit. Installed packages advertise a 5 MiB per-file contract,
    // so update and removal must honor that same boundary end to end.
    const binaryAsset = Buffer.alloc(256 * 1024, 0x5a)
    binaryAsset[0] = 0
    binaryAsset[binaryAsset.byteLength - 1] = 0xff
    const first = staged([
      { path: 'SKILL.md', content: 'first skill' },
      { path: 'assets/data.bin', content: binaryAsset },
    ])
    await store.store(first)
    const initial = await materializer.apply(target(home), {
      operationId: 'initial',
      skillId: 'skill-1',
      targetId: 'agents-standard',
      path: target(home).skillDirectory,
      kind: 'sync',
      previousSnapshotDigest: null,
      previousFiles: [],
      desiredSnapshotDigest: first.snapshotDigest,
      desiredFiles: first.candidate.files,
    })
    expect(initial.ok && initial.materialization?.snapshotDigest).toBe(first.snapshotDigest)
    expect(await readFile(join(target(home).skillDirectory, 'assets', 'data.bin')))
      .toEqual(binaryAsset)

    const second = staged([
      { path: 'SKILL.md', content: 'second skill' },
      { path: 'scripts/check.sh', content: '#!/bin/sh\nexit 0\n', executable: true },
    ])
    await store.store(second)
    const updated = await materializer.apply(target(home), {
      operationId: 'update',
      skillId: 'skill-1',
      targetId: 'agents-standard',
      path: target(home).skillDirectory,
      kind: 'sync',
      previousSnapshotDigest: first.snapshotDigest,
      previousFiles: first.candidate.files,
      desiredSnapshotDigest: second.snapshotDigest,
      desiredFiles: second.candidate.files,
    })
    expect(updated.ok).toBe(true)
    await expect(stat(join(target(home).skillDirectory, 'assets', 'data.bin'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await stat(join(target(home).skillDirectory, 'scripts', 'check.sh'))).mode & 0o111).not.toBe(0)

    const removed = await materializer.apply(target(home), {
      operationId: 'delete',
      skillId: 'skill-1',
      targetId: 'agents-standard',
      path: target(home).skillDirectory,
      kind: 'delete',
      previousSnapshotDigest: second.snapshotDigest,
      previousFiles: second.candidate.files,
      desiredSnapshotDigest: null,
      desiredFiles: [],
    })
    expect(removed).toEqual({ ok: true, materialization: null })
    await expect(stat(target(home).skillFile)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves external edits and unmanaged destination files', async () => {
    const home = await temporaryDirectory()
    const store = new InstalledSkillPackageStore(join(home, 'snapshots'))
    const materializer = new InstalledSkillMaterializer(new SkillPathSafety(home), store)
    const packageValue = staged([{ path: 'SKILL.md', content: 'managed' }])
    await store.store(packageValue)
    const installed = await materializer.apply(target(home), {
      operationId: 'initial',
      skillId: 'skill-1',
      targetId: 'agents-standard',
      path: target(home).skillDirectory,
      kind: 'sync',
      previousSnapshotDigest: null,
      previousFiles: [],
      desiredSnapshotDigest: packageValue.snapshotDigest,
      desiredFiles: packageValue.candidate.files,
    })
    expect(installed.ok).toBe(true)
    await writeFile(target(home).skillFile, 'external edit')
    await chmod(target(home).skillFile, 0o600)

    const removal = await materializer.apply(target(home), {
      operationId: 'delete',
      skillId: 'skill-1',
      targetId: 'agents-standard',
      path: target(home).skillDirectory,
      kind: 'delete',
      previousSnapshotDigest: packageValue.snapshotDigest,
      previousFiles: packageValue.candidate.files,
      desiredSnapshotDigest: null,
      desiredFiles: [],
    })
    expect(removal).toMatchObject({ ok: false, kind: 'conflict' })
    expect(await readFile(target(home).skillFile, 'utf8')).toBe('external edit')

    await writeFile(join(target(home).skillDirectory, 'unmanaged.txt'), 'keep me')
    expect(await materializer.preflight(target(home), undefined)).toMatchObject({
      kind: 'conflict',
    })
    expect(await readFile(join(target(home).skillDirectory, 'unmanaged.txt'), 'utf8')).toBe('keep me')
  })

  it.runIf(process.platform !== 'win32')('treats an external executable-mode change as an ownership conflict', async () => {
    const home = await temporaryDirectory()
    const store = new InstalledSkillPackageStore(join(home, 'snapshots'))
    const materializer = new InstalledSkillMaterializer(new SkillPathSafety(home), store)
    const packageValue = staged([
      { path: 'SKILL.md', content: 'managed' },
      { path: 'scripts/check.sh', content: '#!/bin/sh\nexit 0\n', executable: true },
    ])
    await store.store(packageValue)
    expect((await materializer.apply(target(home), {
      operationId: 'initial-mode',
      skillId: 'skill-1',
      targetId: 'agents-standard',
      path: target(home).skillDirectory,
      kind: 'sync',
      previousSnapshotDigest: null,
      previousFiles: [],
      desiredSnapshotDigest: packageValue.snapshotDigest,
      desiredFiles: packageValue.candidate.files,
    })).ok).toBe(true)
    const script = join(target(home).skillDirectory, 'scripts', 'check.sh')
    await chmod(script, 0o600)

    expect(await materializer.apply(target(home), {
      operationId: 'delete-after-mode-change',
      skillId: 'skill-1',
      targetId: 'agents-standard',
      path: target(home).skillDirectory,
      kind: 'delete',
      previousSnapshotDigest: packageValue.snapshotDigest,
      previousFiles: packageValue.candidate.files,
      desiredSnapshotDigest: null,
      desiredFiles: [],
    })).toMatchObject({ ok: false, kind: 'conflict' })
    expect(await readFile(script, 'utf8')).toBe('#!/bin/sh\nexit 0\n')
  })

  it.runIf(process.platform !== 'win32')('rejects a snapshot directory replaced by a symbolic link', async () => {
    const home = await temporaryDirectory()
    const snapshots = join(home, 'snapshots')
    const store = new InstalledSkillPackageStore(snapshots)
    const packageValue = staged([{ path: 'SKILL.md', content: 'managed' }])
    await store.store(packageValue)
    const snapshot = join(snapshots, packageValue.snapshotDigest)
    await rename(snapshot, join(home, 'original-snapshot'))
    const external = join(home, 'external-snapshot')
    await mkdir(external)
    await writeFile(join(external, 'SKILL.md'), 'managed')
    await symlink(external, snapshot, 'dir')

    await expect(store.verify(
      packageValue.snapshotDigest,
      packageValue.candidate.files,
    )).rejects.toThrow(/regular directory/)
  })
})
