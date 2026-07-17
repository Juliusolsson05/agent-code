import { mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'

import { AiWorkspaceRegistry } from './AiWorkspaceRegistry.js'

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function registryWithAttachedFile(text = 'baseline'): Promise<{
  registry: AiWorkspaceRegistry
  filePath: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'agent-code-ai-workspace-io-'))
  tempRoots.push(root)
  const filePath = join(root, 'attached.txt')
  const statePath = join(root, 'workspaces.json')
  await writeFile(filePath, text)
  await writeFile(
    statePath,
    JSON.stringify({
      workspaces: [
        {
          workspaceId: 'workspace-1',
          name: 'Review',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          entries: [
            {
              entryId: 'entry-1',
              path: filePath,
              projectRoot: root,
              title: 'attached.txt',
              attachedAt: '2026-01-01T00:00:00.000Z',
              status: {
                exists: true,
                readable: true,
                staleReason: null,
                size: text.length,
                mtimeMs: null,
              },
            },
          ],
        },
      ],
    }),
  )
  return { registry: new AiWorkspaceRegistry(statePath), filePath: await realpath(filePath) }
}

describe('AI Workspace editor file authority', () => {
  it('canonicalizes an attached symlink before granting renderer file access', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-code-ai-workspace-link-'))
    tempRoots.push(root)
    const filePath = join(root, 'physical.txt')
    const linkPath = join(root, 'alias.txt')
    await writeFile(filePath, 'content')
    await symlink(filePath, linkPath)
    const registry = new AiWorkspaceRegistry(join(root, 'workspaces.json'))
    const workspace = await registry.create({ name: 'Review' })

    const entry = await registry.attachFile({ workspaceId: workspace.workspaceId, path: linkPath })

    expect(entry.path).toBe(await realpath(filePath))
    await expect(registry.readFile(linkPath)).resolves.toEqual({
      ok: false,
      error: 'file is not attached',
    })
    await expect(registry.readFile(entry.path)).resolves.toMatchObject({ ok: true })
  })

  it('derives LSP authority from a main-owned workspace entry', async () => {
    const { registry, filePath } = await registryWithAttachedFile()
    const physicalRoot = await realpath(dirname(filePath))

    await expect(registry.authorizeLspEntry('workspace-1', 'entry-1')).resolves.toEqual({
      workspaceRoot: physicalRoot,
      filePath: 'attached.txt',
    })
    await expect(registry.authorizeLspEntry('workspace-1', 'missing')).rejects.toThrow(
      'AI Workspace entry has no project root',
    )
  })

  it('rejects renderer reads and writes for paths that were never attached', async () => {
    const { registry, filePath } = await registryWithAttachedFile()
    const unknown = `${filePath}.unknown`

    await expect(registry.readFile(unknown)).resolves.toEqual({
      ok: false,
      error: 'file is not attached',
    })
    await expect(registry.writeFile({ path: unknown, text: 'nope' })).resolves.toEqual({
      ok: false,
      error: 'file is not attached',
    })
  })

  it('uses opaque versions for change/deletion conflicts and explicit recreation', async () => {
    const { registry, filePath } = await registryWithAttachedFile()
    const initial = await registry.readFile(filePath)
    expect(initial.ok).toBe(true)
    if (!initial.ok) return

    await writeFile(filePath, 'external change')
    await expect(
      registry.writeFile({
        path: filePath,
        text: 'editor change',
        expectedVersion: initial.version,
      }),
    ).resolves.toMatchObject({ ok: false, conflict: true, conflictKind: 'changed' })
    await expect(readFile(filePath, 'utf8')).resolves.toBe('external change')

    const latest = await registry.readFile(filePath)
    expect(latest.ok).toBe(true)
    if (!latest.ok) return
    await unlink(filePath)
    await expect(
      registry.writeFile({
        path: filePath,
        text: 'editor change',
        expectedVersion: latest.version,
      }),
    ).resolves.toMatchObject({ ok: false, conflict: true, conflictKind: 'deleted' })

    await expect(
      registry.writeFile({ path: filePath, text: 'recreated', expectedVersion: null }),
    ).resolves.toMatchObject({ ok: true })
    await expect(readFile(filePath, 'utf8')).resolves.toBe('recreated')
  })
})
