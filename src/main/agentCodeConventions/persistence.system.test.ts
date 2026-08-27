import { createHash } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'

import { createEmptyAgentCodeConventionsDocument } from '@shared/types/agentCodeConventions.js'
import {
  readAgentCodeConventionsState,
  writeAgentCodeConventionsState,
} from './persistence.js'

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'agent-code-conventions-persistence-'))
  temporaryDirectories.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('Agent Code conventions persistence', () => {
  it('round-trips app-owned state atomically', async () => {
    const root = await temporaryDirectory()
    const statePath = join(root, 'state', 'conventions.json')
    const document = createEmptyAgentCodeConventionsDocument()
    document.revision = 3
    document.markdown = '# Rules'
    await writeAgentCodeConventionsState(statePath, document)

    expect(await readAgentCodeConventionsState(statePath)).toEqual({ kind: 'ok', document })
    expect((await readFile(statePath, 'utf8')).endsWith('\n')).toBe(true)
  })

  it('tightens an existing state file to private permissions', async () => {
    const root = await temporaryDirectory()
    const statePath = join(root, 'conventions.json')
    await writeFile(statePath, '{}')
    await chmod(statePath, 0o644)

    await writeAgentCodeConventionsState(statePath, createEmptyAgentCodeConventionsDocument())

    expect((await stat(statePath)).mode & 0o777).toBe(0o600)
  })

  it('preserves malformed and unsupported state as recovery-required', async () => {
    const root = await temporaryDirectory()
    const malformed = join(root, 'malformed.json')
    await writeFile(malformed, '{not json')
    expect(await readAgentCodeConventionsState(malformed)).toMatchObject({
      kind: 'recovery-required',
      stateFilePath: malformed,
    })

    const newer = join(root, 'newer.json')
    await writeFile(newer, JSON.stringify({
      schemaVersion: 999,
      revision: 7,
      enabled: true,
      markdown: '# Preserve me',
      updatedAt: null,
      materializations: {},
      pendingOperations: {},
    }))
    expect(await readAgentCodeConventionsState(newer)).toMatchObject({
      kind: 'recovery-required',
      document: { revision: 7, enabled: true, markdown: '# Preserve me' },
    })
  })

  it('migrates schema-v1 conventions without changing ownership evidence', async () => {
    const root = await temporaryDirectory()
    const statePath = join(root, 'conventions.json')
    const skillPath = join(root, '.agents', 'skills', 'agent-code-conventions', 'SKILL.md')
    const legacy = {
      schemaVersion: 1,
      revision: 7,
      enabled: true,
      markdown: '# Preserve me',
      updatedAt: '2026-08-26T00:00:00.000Z',
      materializations: {
        'agents-standard-personal-skills': { path: skillPath, sha256: 'a'.repeat(64) },
      },
      pendingOperations: {},
    }
    await writeFile(statePath, JSON.stringify(legacy))

    expect(await readAgentCodeConventionsState(statePath)).toEqual({
      kind: 'ok',
      document: {
        ...legacy,
        schemaVersion: 3,
        customSkills: {},
        installedSkills: {},
        installedMaterializations: {},
        installedPendingOperations: {},
      },
    })
  })

  it('migrates schema-v2 custom skills without adopting external package state', async () => {
    const root = await temporaryDirectory()
    const statePath = join(root, 'conventions.json')
    const current = createEmptyAgentCodeConventionsDocument()
    const previous = {
      schemaVersion: 2,
      revision: 4,
      enabled: current.enabled,
      markdown: current.markdown,
      updatedAt: current.updatedAt,
      customSkills: {
        custom: {
          id: 'custom',
          name: 'custom-skill',
          description: 'A custom skill.',
          markdown: '# Custom',
          enabled: false,
          createdAt: '2026-08-26T00:00:00.000Z',
          updatedAt: '2026-08-26T00:00:00.000Z',
        },
      },
      materializations: {},
      pendingOperations: {},
    }
    await writeFile(statePath, JSON.stringify(previous))

    expect(await readAgentCodeConventionsState(statePath)).toEqual({
      kind: 'ok',
      document: {
        ...previous,
        schemaVersion: 3,
        installedSkills: {},
        installedMaterializations: {},
        installedPendingOperations: {},
      },
    })
  })

  it('accepts only installed records whose immutable manifest matches its snapshot digest', async () => {
    const root = await temporaryDirectory()
    const statePath = join(root, 'conventions.json')
    const document = createEmptyAgentCodeConventionsDocument()
    const file = {
      path: 'SKILL.md',
      bytes: 10,
      sha256: 'a'.repeat(64),
      executable: false,
    }
    const snapshotDigest = createHash('sha256')
      .update(file.path).update('\0')
      .update(file.sha256).update('\0')
      .update('0').update('\0')
      .digest('hex')
    document.installedSkills['skill-1'] = {
      id: 'skill-1',
      name: 'review-code',
      description: 'Review code.',
      enabled: false,
      source: {
        owner: 'example',
        repository: 'skills',
        repositoryUrl: 'https://github.com/example/skills',
        requestedRef: 'main',
        requestedRefType: 'branch',
        path: 'skills/review-code',
        skillUrl: 'https://github.com/example/skills/tree/main/skills/review-code',
        resolvedCommit: 'b'.repeat(40),
      },
      snapshotDigest,
      files: [file],
      warnings: [],
      createdAt: '2026-08-27T00:00:00.000Z',
      updatedAt: '2026-08-27T00:00:00.000Z',
    }
    await writeFile(statePath, JSON.stringify(document))
    expect(await readAgentCodeConventionsState(statePath)).toEqual({ kind: 'ok', document })

    document.installedSkills['skill-1']!.snapshotDigest = 'c'.repeat(64)
    await writeFile(statePath, JSON.stringify(document))
    expect(await readAgentCodeConventionsState(statePath)).toMatchObject({
      kind: 'recovery-required',
      document: { installedSkills: {} },
    })
  })

  it('treats duplicate or path-shaped custom skill names as recovery-required', async () => {
    const root = await temporaryDirectory()
    const statePath = join(root, 'conventions.json')
    const document = createEmptyAgentCodeConventionsDocument()
    const timestamp = '2026-08-26T00:00:00.000Z'
    document.customSkills = {
      one: { id: 'one', name: 'same-name', description: 'One', markdown: '# One', enabled: false, createdAt: timestamp, updatedAt: timestamp },
      two: { id: 'two', name: 'same-name', description: 'Two', markdown: '# Two', enabled: false, createdAt: timestamp, updatedAt: timestamp },
    }
    await writeFile(statePath, JSON.stringify(document))
    expect(await readAgentCodeConventionsState(statePath)).toMatchObject({ kind: 'recovery-required' })

    document.customSkills = {
      unsafe: { id: 'unsafe', name: '../escape', description: 'Unsafe', markdown: '# Unsafe', enabled: false, createdAt: timestamp, updatedAt: timestamp },
    }
    await writeFile(statePath, JSON.stringify(document))
    expect(await readAgentCodeConventionsState(statePath)).toMatchObject({ kind: 'recovery-required' })
  })

  it.runIf(process.platform !== 'win32')('rejects a symlink state file without following it', async () => {
    const root = await temporaryDirectory()
    const source = join(root, 'source.json')
    const statePath = join(root, 'conventions.json')
    await writeFile(source, JSON.stringify(createEmptyAgentCodeConventionsDocument()))
    await symlink(source, statePath)
    expect(await readAgentCodeConventionsState(statePath)).toMatchObject({
      kind: 'recovery-required',
      stateFilePath: statePath,
    })
  })
})
