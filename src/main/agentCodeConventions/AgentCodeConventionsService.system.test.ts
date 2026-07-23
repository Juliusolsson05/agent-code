import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  createEmptyAgentCodeConventionsDocument,
  type AgentCodeConventionsDocument,
} from '@shared/types/agentCodeConventions.js'
import { renderAgentCodeConventionsSkill, sha256Text } from './renderSkill.js'
import { journalTemporaryPath } from './skillPathSafety.js'
import type {
  AgentCodeConventionsTarget,
  ResolvedAgentCodeConventionsTargets,
} from './targets.js'
import { AgentCodeConventionsService } from './AgentCodeConventionsService.js'

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'agent-code-conventions-service-'))
  temporaryDirectories.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function target(id: string, skillsDirectory: string, providers: AgentCodeConventionsTarget['providers']): AgentCodeConventionsTarget {
  const skillDirectory = join(skillsDirectory, 'agent-code-conventions')
  return {
    id,
    providers,
    providerNames: providers,
    skillsDirectory,
    skillDirectory,
    skillFile: join(skillDirectory, 'SKILL.md'),
  }
}

async function harness(): Promise<{
  root: string
  stateFilePath: string
  targets: AgentCodeConventionsTarget[]
  service: AgentCodeConventionsService
}> {
  const root = await temporaryDirectory()
  const targets = [
    target('claude-personal-skills', join(root, '.claude', 'skills'), ['claude', 'opencode']),
    target('agents-standard-personal-skills', join(root, '.agents', 'skills'), ['codex', 'opencode']),
  ]
  const resolved: ResolvedAgentCodeConventionsTargets = { targets, unsupportedProviders: [] }
  const stateFilePath = join(root, '.config', 'agent-code', 'conventions.json')
  const service = new AgentCodeConventionsService({
    stateFilePath,
    homeDirectory: root,
    resolveTargets: async () => resolved,
    now: () => new Date('2026-07-23T00:00:00.000Z'),
    operationId: (() => { let value = 0; return () => `operation-${++value}` })(),
  })
  await service.initialize()
  return { root, stateFilePath, targets, service }
}

describe('AgentCodeConventionsService', () => {
  it('keeps disabled saves app-owned and materializes identical provider copies only on enable', async () => {
    const { root, targets, service } = await harness()
    expect((await service.getSnapshot()).health).toBe('disabled')
    await expect(stat(join(root, '.claude'))).rejects.toMatchObject({ code: 'ENOENT' })

    const saved = await service.save({ expectedRevision: 0, enabled: false, markdown: '# Rules' })
    expect(saved).toMatchObject({ ok: true, snapshot: { revision: 1, enabled: false } })
    await expect(stat(join(root, '.agents'))).rejects.toMatchObject({ code: 'ENOENT' })

    const enabled = await service.save({ expectedRevision: 1, enabled: true, markdown: '# Rules' })
    expect(enabled).toMatchObject({ ok: true, snapshot: { revision: 2, health: 'active' } })
    const copies = await Promise.all(targets.map(value => readFile(value.skillFile, 'utf8')))
    expect(copies[0]).toBe(copies[1])
    expect(copies[0]).toBe(renderAgentCodeConventionsSkill('# Rules'))

    const disabled = await service.disable(2)
    expect(disabled).toMatchObject({ ok: true, snapshot: { revision: 3, enabled: false, markdown: '# Rules' } })
    await Promise.all(targets.map(value => expect(stat(value.skillFile)).rejects.toMatchObject({ code: 'ENOENT' })))
  })

  it('does not advance in-memory state when a disabled save cannot persist', async () => {
    const { root, service } = await harness()
    await rm(join(root, '.config'), { recursive: true })
    await writeFile(join(root, '.config'), 'blocks the state directory')

    const result = await service.save({ expectedRevision: 0, enabled: false, markdown: '# Rules' })

    expect(result).toMatchObject({ ok: false, code: 'io-error', snapshot: { revision: 0 } })
    expect(await service.getSnapshot()).toMatchObject({ revision: 0, markdown: '', enabled: false })
  })

  it('preflights every target before writing and binds overwrite to the reviewed fingerprint', async () => {
    const { targets, service } = await harness()
    await writeFileWithParents(targets[0]!.skillFile, 'unmanaged')

    const blocked = await service.save({ expectedRevision: 0, enabled: true, markdown: '# Rules' })
    expect(blocked).toMatchObject({ ok: false, code: 'target-conflict' })
    await expect(stat(targets[1]!.skillFile)).rejects.toMatchObject({ code: 'ENOENT' })
    if (blocked.ok || blocked.code !== 'target-conflict') throw new Error('expected target conflict')
    const conflict = blocked.snapshot.targets.find(value => value.id === targets[0]!.id)
    expect(conflict?.conflictFingerprint).toBeTruthy()

    await writeFile(targets[0]!.skillFile, 'changed after review')
    const stale = await service.save({
      expectedRevision: 0,
      enabled: true,
      markdown: '# Rules',
      overwriteTargets: [{
        targetId: targets[0]!.id,
        expectedConflictFingerprint: conflict!.conflictFingerprint!,
      }],
    })
    expect(stale).toMatchObject({ ok: false, code: 'target-conflict' })
    expect(await readFile(targets[0]!.skillFile, 'utf8')).toBe('changed after review')
  })

  it('replaces an unmanaged regular file only after exact fingerprint approval', async () => {
    const { targets, service } = await harness()
    await writeFileWithParents(targets[0]!.skillFile, 'unmanaged')

    const blocked = await service.save({ expectedRevision: 0, enabled: true, markdown: '# Rules' })
    if (blocked.ok || blocked.code !== 'target-conflict') throw new Error('expected target conflict')
    const conflict = blocked.snapshot.targets.find(value => value.id === targets[0]!.id)

    const enabled = await service.save({
      expectedRevision: 0,
      enabled: true,
      markdown: '# Rules',
      overwriteTargets: [{
        targetId: targets[0]!.id,
        expectedConflictFingerprint: conflict!.conflictFingerprint!,
      }],
    })

    expect(enabled).toMatchObject({ ok: true, snapshot: { health: 'active' } })
    expect(await readFile(targets[0]!.skillFile, 'utf8')).toBe(
      renderAgentCodeConventionsSkill('# Rules'),
    )
  })

  it('preserves modified copies on disable and requires explicit abandonment before clear', async () => {
    const { targets, service } = await harness()
    await service.save({ expectedRevision: 0, enabled: true, markdown: '# Rules' })
    await writeFile(targets[0]!.skillFile, 'external edit')

    const disabled = await service.disable(1)
    expect(disabled).toMatchObject({ ok: true, snapshot: { enabled: false, health: 'conflict' } })
    if (!disabled.ok) throw new Error('disable failed')
    const blocked = await service.clear({ expectedRevision: disabled.snapshot.revision })
    expect(blocked).toMatchObject({ ok: false, code: 'clear-blocked' })
    if (blocked.ok || blocked.code !== 'clear-blocked') throw new Error('expected blocked clear')
    expect(blocked.snapshot.markdown).toBe('# Rules')
    const remnant = blocked.snapshot.targets.find(value => value.id === targets[0]!.id)

    const cleared = await service.clear({
      expectedRevision: blocked.snapshot.revision,
      abandonTargets: [{
        targetId: remnant!.id,
        expectedConflictFingerprint: remnant!.conflictFingerprint!,
      }],
    })
    expect(cleared).toMatchObject({ ok: true, snapshot: { markdown: '', health: 'disabled' } })
    expect(await readFile(targets[0]!.skillFile, 'utf8')).toBe('external edit')
  })

  it('adopts generated bytes only with a matching persisted pending operation', async () => {
    const root = await temporaryDirectory()
    const currentTarget = target('agents-standard-personal-skills', join(root, '.agents', 'skills'), ['codex'])
    const stateFilePath = join(root, 'state', 'conventions.json')
    const markdown = '# Rules'
    const rendered = renderAgentCodeConventionsSkill(markdown)
    await writeFileWithParents(currentTarget.skillFile, rendered)

    const unmanaged = new AgentCodeConventionsService({
      stateFilePath,
      homeDirectory: root,
      resolveTargets: async () => ({ targets: [currentTarget], unsupportedProviders: [] }),
    })
    await unmanaged.initialize()
    const blocked = await unmanaged.save({ expectedRevision: 0, enabled: true, markdown })
    expect(blocked).toMatchObject({ ok: false, code: 'target-conflict' })

    const document: AgentCodeConventionsDocument = {
      ...createEmptyAgentCodeConventionsDocument(),
      enabled: true,
      markdown,
      pendingOperations: {
        [currentTarget.id]: {
          operationId: 'crashed-write',
          targetId: currentTarget.id,
          path: currentTarget.skillFile,
          kind: 'write',
          previousSha256: null,
          desiredSha256: sha256Text(rendered),
        },
      },
    }
    await writeFileWithParents(stateFilePath, `${JSON.stringify(document)}\n`)
    const recovered = new AgentCodeConventionsService({
      stateFilePath,
      homeDirectory: root,
      resolveTargets: async () => ({ targets: [currentTarget], unsupportedProviders: [] }),
    })
    await recovered.initialize()
    expect(await recovered.getSnapshot()).toMatchObject({ enabled: true, health: 'active' })
  })

  it('removes a journal-only published write while disabled', async () => {
    const root = await temporaryDirectory()
    const currentTarget = target('agents-standard-personal-skills', join(root, '.agents', 'skills'), ['codex'])
    const stateFilePath = join(root, 'state', 'conventions.json')
    const rendered = renderAgentCodeConventionsSkill('# Rules')
    await writeFileWithParents(currentTarget.skillFile, rendered)
    const document: AgentCodeConventionsDocument = {
      ...createEmptyAgentCodeConventionsDocument(),
      pendingOperations: {
        [currentTarget.id]: {
          operationId: 'published-before-crash',
          targetId: currentTarget.id,
          path: currentTarget.skillFile,
          kind: 'write',
          previousSha256: null,
          desiredSha256: sha256Text(rendered),
        },
      },
    }
    await writeFileWithParents(stateFilePath, `${JSON.stringify(document)}\n`)

    const service = new AgentCodeConventionsService({
      stateFilePath,
      homeDirectory: root,
      resolveTargets: async () => ({ targets: [currentTarget], unsupportedProviders: [] }),
    })
    await service.initialize()

    expect(await service.getSnapshot()).toMatchObject({ enabled: false, health: 'disabled' })
    await expect(stat(currentTarget.skillFile)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await stat(currentTarget.skillDirectory)).isDirectory()).toBe(true)
  })

  it('cleans only the operation-bound crash temp before retrying publication', async () => {
    const root = await temporaryDirectory()
    const currentTarget = target('agents-standard-personal-skills', join(root, '.agents', 'skills'), ['codex'])
    const stateFilePath = join(root, 'state', 'conventions.json')
    const markdown = '# Rules'
    const rendered = renderAgentCodeConventionsSkill(markdown)
    const operationId = 'crashed-temp-write'
    const tempPath = journalTemporaryPath(currentTarget.skillFile, operationId)
    await writeFileWithParents(tempPath, 'partially written bytes')
    const document: AgentCodeConventionsDocument = {
      ...createEmptyAgentCodeConventionsDocument(),
      enabled: true,
      markdown,
      pendingOperations: {
        [currentTarget.id]: {
          operationId,
          targetId: currentTarget.id,
          path: currentTarget.skillFile,
          kind: 'write',
          previousSha256: null,
          desiredSha256: sha256Text(rendered),
        },
      },
    }
    await writeFileWithParents(stateFilePath, `${JSON.stringify(document)}\n`)

    const service = new AgentCodeConventionsService({
      stateFilePath,
      homeDirectory: root,
      resolveTargets: async () => ({ targets: [currentTarget], unsupportedProviders: [] }),
    })
    await service.initialize()

    expect(await service.getSnapshot()).toMatchObject({ enabled: true, health: 'active' })
    expect(await readFile(currentTarget.skillFile, 'utf8')).toBe(rendered)
    await expect(stat(tempPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('treats the leaf directory as harmless residue across a crash before publication', async () => {
    const root = await temporaryDirectory()
    const currentTarget = target('agents-standard-personal-skills', join(root, '.agents', 'skills'), ['codex'])
    const stateFilePath = join(root, 'state', 'conventions.json')
    const markdown = '# Rules'
    const rendered = renderAgentCodeConventionsSkill(markdown)
    await mkdir(currentTarget.skillDirectory, { recursive: true })
    const document: AgentCodeConventionsDocument = {
      ...createEmptyAgentCodeConventionsDocument(),
      enabled: true,
      markdown,
      pendingOperations: {
        [currentTarget.id]: {
          operationId: 'crashed-before-publication',
          targetId: currentTarget.id,
          path: currentTarget.skillFile,
          kind: 'write',
          previousSha256: null,
          desiredSha256: sha256Text(rendered),
        },
      },
    }
    await writeFileWithParents(stateFilePath, `${JSON.stringify(document)}\n`)

    const service = new AgentCodeConventionsService({
      stateFilePath,
      homeDirectory: root,
      resolveTargets: async () => ({ targets: [currentTarget], unsupportedProviders: [] }),
    })
    await service.initialize()
    const disabled = await service.disable(0)

    expect(disabled).toMatchObject({ ok: true, snapshot: { health: 'disabled' } })
    await expect(stat(currentTarget.skillFile)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await stat(currentTarget.skillDirectory)).isDirectory()).toBe(true)
  })

  it('repairs a missing owned copy during startup reconciliation', async () => {
    const { root, stateFilePath, targets, service } = await harness()
    await service.save({ expectedRevision: 0, enabled: true, markdown: '# Rules' })
    await rm(targets[0]!.skillFile)

    const restarted = new AgentCodeConventionsService({
      stateFilePath,
      homeDirectory: root,
      resolveTargets: async () => ({ targets, unsupportedProviders: [] }),
    })
    await restarted.initialize()

    expect(await restarted.getSnapshot()).toMatchObject({ enabled: true, health: 'active' })
    expect(await readFile(targets[0]!.skillFile, 'utf8')).toBe(
      renderAgentCodeConventionsSkill('# Rules'),
    )
  })

  it('installs the new external Claude root but preserves the retired root for manual cleanup', async () => {
    const root = await realpath(await temporaryDirectory())
    const home = join(root, 'home')
    const oldTarget = target('claude-personal-skills', join(root, 'claude-old', 'skills'), ['claude'])
    const newTarget = target('claude-personal-skills', join(root, 'claude-new', 'skills'), ['claude'])
    const stateFilePath = join(home, '.config', 'agent-code', 'conventions.json')
    const original = new AgentCodeConventionsService({
      stateFilePath,
      homeDirectory: home,
      resolveTargets: async () => ({ targets: [oldTarget], unsupportedProviders: [] }),
    })
    await original.initialize()
    await expect(original.save({ expectedRevision: 0, enabled: true, markdown: '# Rules' }))
      .resolves.toMatchObject({ ok: true })

    const restarted = new AgentCodeConventionsService({
      stateFilePath,
      homeDirectory: home,
      resolveTargets: async () => ({ targets: [newTarget], unsupportedProviders: [] }),
    })
    await restarted.initialize()

    expect(await restarted.getSnapshot()).toMatchObject({ enabled: true, health: 'conflict' })
    expect(await readFile(newTarget.skillFile, 'utf8')).toBe(
      renderAgentCodeConventionsSkill('# Rules'),
    )
    expect(await readFile(oldTarget.skillFile, 'utf8')).toBe(
      renderAgentCodeConventionsSkill('# Rules'),
    )
  })

  it('preserves a journal-only copy when an external Claude root moves', async () => {
    const root = await realpath(await temporaryDirectory())
    const home = join(root, 'home')
    const oldTarget = target('claude-personal-skills', join(root, 'claude-old', 'skills'), ['claude'])
    const newTarget = target('claude-personal-skills', join(root, 'claude-new', 'skills'), ['claude'])
    const stateFilePath = join(home, '.config', 'agent-code', 'conventions.json')
    const markdown = '# Rules'
    const rendered = renderAgentCodeConventionsSkill(markdown)
    await writeFileWithParents(oldTarget.skillFile, rendered)
    const document: AgentCodeConventionsDocument = {
      ...createEmptyAgentCodeConventionsDocument(),
      enabled: true,
      markdown,
      pendingOperations: {
        [oldTarget.id]: {
          operationId: 'published-at-old-root',
          targetId: oldTarget.id,
          path: oldTarget.skillFile,
          kind: 'write',
          previousSha256: null,
          desiredSha256: sha256Text(rendered),
        },
      },
    }
    await writeFileWithParents(stateFilePath, `${JSON.stringify(document)}\n`)
    const service = new AgentCodeConventionsService({
      stateFilePath,
      homeDirectory: home,
      resolveTargets: async () => ({ targets: [newTarget], unsupportedProviders: [] }),
    })

    await service.initialize()

    expect(await service.getSnapshot()).toMatchObject({
      enabled: true,
      health: 'conflict',
      recovery: undefined,
    })
    expect(await readFile(oldTarget.skillFile, 'utf8')).toBe(rendered)
    expect(await readFile(newTarget.skillFile, 'utf8')).toBe(rendered)
  })

  it('never removes the leaf directory after removing its generated file', async () => {
    const { targets, service } = await harness()
    const currentTarget = targets[0]!
    await service.save({ expectedRevision: 0, enabled: true, markdown: '# Rules' })

    await service.disable(1)

    expect((await stat(currentTarget.skillDirectory)).isDirectory()).toBe(true)
  })

  it('blocks an all-provider enable when a registered provider is unsupported', async () => {
    const root = await temporaryDirectory()
    const currentTarget = target(
      'agents-standard-personal-skills',
      join(root, '.agents', 'skills'),
      ['codex'],
    )
    const service = new AgentCodeConventionsService({
      stateFilePath: join(root, 'state', 'conventions.json'),
      homeDirectory: root,
      resolveTargets: async () => ({
        targets: [currentTarget],
        unsupportedProviders: ['opencode'],
      }),
    })
    await service.initialize()

    const result = await service.save({ expectedRevision: 0, enabled: true, markdown: '# Rules' })

    expect(result).toMatchObject({
      ok: false,
      code: 'unsupported',
      snapshot: { enabled: false, health: 'unsupported' },
    })
    await expect(stat(currentTarget.skillFile)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.runIf(process.platform !== 'win32')('rejects symlinked provider roots', async () => {
    const root = await temporaryDirectory()
    const real = join(root, 'real-skills')
    const linked = join(root, 'linked-skills')
    await writeFileWithParents(join(real, '.keep'), 'keep')
    await symlink(real, linked)
    const currentTarget = target('linked', linked, ['codex'])
    const service = new AgentCodeConventionsService({
      stateFilePath: join(root, 'state', 'conventions.json'),
      homeDirectory: root,
      resolveTargets: async () => ({ targets: [currentTarget], unsupportedProviders: [] }),
    })
    await service.initialize()
    const result = await service.save({ expectedRevision: 0, enabled: true, markdown: '# Rules' })
    expect(result).toMatchObject({ ok: false, code: 'target-conflict' })
    await expect(stat(join(real, 'agent-code-conventions'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.runIf(process.platform !== 'win32')('does not delete matching bytes through a swapped parent symlink', async () => {
    const { root, service } = await harness()
    await service.save({ expectedRevision: 0, enabled: true, markdown: '# Rules' })

    const originalAgents = join(root, 'original-agents')
    const externalAgents = join(root, 'external-agents')
    await rename(join(root, '.agents'), originalAgents)
    await writeFileWithParents(
      join(externalAgents, 'skills', 'agent-code-conventions', 'SKILL.md'),
      renderAgentCodeConventionsSkill('# Rules'),
    )
    await symlink(externalAgents, join(root, '.agents'))

    const disabled = await service.disable(1)
    expect(disabled).toMatchObject({ ok: true, snapshot: { health: 'conflict' } })
    expect(await readFile(
      join(externalAgents, 'skills', 'agent-code-conventions', 'SKILL.md'),
      'utf8',
    )).toBe(renderAgentCodeConventionsSkill('# Rules'))
    expect(await readFile(
      join(originalAgents, 'skills', 'agent-code-conventions', 'SKILL.md'),
      'utf8',
    )).toBe(renderAgentCodeConventionsSkill('# Rules'))
  })

  it('preserves syntactically valid state whose ownership path is unsafe', async () => {
    const root = await temporaryDirectory()
    const stateFilePath = join(root, 'state', 'conventions.json')
    const unrelated = join(root, 'unrelated', 'skills', 'agent-code-conventions', 'SKILL.md')
    await writeFileWithParents(unrelated, 'do not delete')
    const document: AgentCodeConventionsDocument = {
      ...createEmptyAgentCodeConventionsDocument(),
      materializations: {
        arbitrary: {
          path: unrelated,
          sha256: sha256Text('do not delete'),
        },
      },
    }
    await writeFileWithParents(stateFilePath, `${JSON.stringify(document)}\n`)
    const service = new AgentCodeConventionsService({
      stateFilePath,
      homeDirectory: root,
      resolveTargets: async () => ({ targets: [], unsupportedProviders: [] }),
    })

    await service.initialize()

    expect(await service.getSnapshot()).toMatchObject({
      health: 'recovery-required',
      recovery: { stateFilePath },
    })
    expect(await readFile(unrelated, 'utf8')).toBe('do not delete')
  })

  it('never turns a known provider id into authority over a historical path', async () => {
    const root = await temporaryDirectory()
    const stateFilePath = join(root, 'state', 'conventions.json')
    const currentTarget = target('claude-personal-skills', join(root, '.claude', 'skills'), ['claude'])
    const unrelated = join(root, 'unrelated', 'skills', 'agent-code-conventions', 'SKILL.md')
    const contents = 'do not delete'
    await writeFileWithParents(unrelated, contents)
    const document: AgentCodeConventionsDocument = {
      ...createEmptyAgentCodeConventionsDocument(),
      materializations: {
        [currentTarget.id]: {
          path: unrelated,
          sha256: sha256Text(contents),
        },
      },
    }
    await writeFileWithParents(stateFilePath, `${JSON.stringify(document)}\n`)
    const service = new AgentCodeConventionsService({
      stateFilePath,
      homeDirectory: root,
      resolveTargets: async () => ({ targets: [currentTarget], unsupportedProviders: [] }),
    })

    await service.initialize()

    expect(await service.getSnapshot()).toMatchObject({ health: 'conflict' })
    expect(await readFile(unrelated, 'utf8')).toBe(contents)
  })

  it('refuses to enable when provider target discovery fails', async () => {
    const root = await temporaryDirectory()
    const service = new AgentCodeConventionsService({
      stateFilePath: join(root, 'state', 'conventions.json'),
      homeDirectory: root,
      resolveTargets: async () => { throw new Error('registry failure') },
    })
    await service.initialize()

    const result = await service.save({ expectedRevision: 0, enabled: true, markdown: '# Rules' })

    expect(result).toMatchObject({
      ok: false,
      code: 'io-error',
      snapshot: { enabled: false, health: 'degraded' },
    })
    await expect(stat(join(root, '.agents'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

async function writeFileWithParents(path: string, contents: string): Promise<void> {
  const { mkdir } = await import('fs/promises')
  const { dirname } = await import('path')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, contents)
}
