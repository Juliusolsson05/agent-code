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

// #1246: one malformed row used to throw inside load(); the rejected load was
// cached, so every AI Workspace operation failed for the rest of the process,
// and list() read updatedAt / entry.status unguarded. Real workspaces from the
// owner's ai-workspaces.json (testing/fixtures/ai-workspace, redacted).
describe('malformed rows in a real registry (#1246)', () => {
  async function realState() {
    const { readFile: read } = await import('fs/promises')
    return (JSON.parse(await read(join(import.meta.dirname,
      '../../../testing/fixtures/ai-workspace/real-workspaces-2026-09-25.json'), 'utf8')) as {
      state: { workspaces: Array<Record<string, any>> }
    }).state
  }
  async function registryFor(state: unknown) {
    const root = await mkdtemp(join(tmpdir(), 'agent-code-ai-workspace-malformed-'))
    tempRoots.push(root)
    const statePath = join(root, 'ai-workspaces.json')
    const source = JSON.stringify(state)
    await writeFile(statePath, source)
    return { root, statePath, source, registry: new AiWorkspaceRegistry(statePath) }
  }

  it('sets a bad entry and a bad workspace aside and keeps every other operation working', async () => {
    const state = await realState()
    const [kept, broken] = state.workspaces
    // A newer or hand-edited file: one entry with a non-string path, one
    // workspace with a non-string timestamp.
    kept!.entries.push({ ...kept!.entries[0], entryId: 'bad-entry', path: 42 })
    broken!.updatedAt = 1789000000
    const { root, source, registry } = await registryFor(state)

    const listed = await registry.list()
    expect(listed.map(workspace => workspace.workspaceId)).toEqual([kept!.workspaceId])
    expect(listed[0]!.fileCount).toBe(1)
    // Writes work too, and the bad rows' bytes survive the save that drops them.
    await registry.create({ name: 'Fresh' })
    const { readdir, readFile: read } = await import('fs/promises')
    const preserved = (await readdir(root)).filter(name => name.startsWith('ai-workspaces.json.invalid-'))
    expect(preserved).toHaveLength(1)
    expect(await read(join(root, preserved[0]!), 'utf8')).toBe(source)
  })

  it('keeps an entry whose stored status is malformed, with an unknown status', async () => {
    const state = await realState()
    state.workspaces[0]!.entries[0]!.status = null
    const { registry } = await registryFor(state)
    const listed = await registry.list()
    const workspace = listed.find(candidate => candidate.workspaceId === state.workspaces[0]!.workspaceId)!
    expect(workspace.fileCount).toBe(1)
    // Reported as stale until refreshed, never as a healthy file.
    expect(workspace.staleCount).toBe(1)
  })

  it.each([
    ['entries not a list', (state: { workspaces: Array<Record<string, any>> }) => { state.workspaces[1]!.entries = 5 }],
    ['a non-string name', (state: { workspaces: Array<Record<string, any>> }) => { state.workspaces[1]!.name = 7 }],
    ['a non-string entryId', (state: { workspaces: Array<Record<string, any>> }) => { state.workspaces[1]!.entries[0].entryId = 7 }],
  ])('keeps the other workspace working when one row has %s', async (_label, damage) => {
    const state = await realState()
    damage(state)
    const { registry } = await registryFor(state)
    expect((await registry.list()).map(workspace => workspace.workspaceId)).toContain(state.workspaces[0]!.workspaceId)
  })

  it('drops mistyped optional fields instead of passing them to the UI (review A)', async () => {
    const state = await realState()
    state.workspaces[0]!.description = { not: 'text' }
    state.workspaces[0]!.entries[0].projectRoot = 42
    state.workspaces[0]!.entries[0].title = 9
    const { registry } = await registryFor(state)
    const listed = (await registry.list()).find(workspace => workspace.workspaceId === state.workspaces[0]!.workspaceId)!
    expect(listed).not.toHaveProperty('description')
    const opened = (await registry.get(state.workspaces[0]!.workspaceId))!
    expect(opened.entries[0]).not.toHaveProperty('projectRoot')
    expect(opened.entries[0]!.title).toBe('file-0.md')
  })

  it.each([
    ['workspaces not a list', { workspaces: 5 }],
    ['a typo\'d key', { workspces: [{ workspaceId: 'typo-key' }] }],
    ['a top-level list', []],
  ])('still refuses a malformed container (%s), which the next save would erase', async (_label, document) => {
    const { statePath, source, registry } = await registryFor(document)
    await expect(registry.list()).rejects.toThrow('storage is invalid')
    const { readFile: read } = await import('fs/promises')
    expect(await read(statePath, 'utf8')).toBe(source)
  })

  it('keeps reads working when the copy cannot be made, and refuses saves until it can', async () => {
    const state = await realState()
    state.workspaces[1]!.updatedAt = 1789000000
    const { root, statePath, source, registry } = await registryFor(state)
    const { createHash } = await import('node:crypto')
    const { mkdir, readFile: read } = await import('fs/promises')
    const occupied = join(root, `ai-workspaces.json.invalid-${createHash('sha256').update(source).digest('hex').slice(0, 16)}.json`)
    await mkdir(occupied)
    expect((await registry.list()).map(workspace => workspace.workspaceId)).toEqual([state.workspaces[0]!.workspaceId])
    await expect(registry.create({ name: 'Blocked' })).rejects.toThrow()
    expect(await read(statePath, 'utf8')).toBe(source)
    await rm(occupied, { recursive: true })
    await registry.create({ name: 'Now' })
    expect(await read(occupied, 'utf8')).toBe(source)
  })

  it('does not cache a failed load: the next call re-reads the file', async () => {
    const state = await realState()
    const { statePath, registry } = await registryFor(state)
    const { chmod } = await import('fs/promises')
    await chmod(statePath, 0o000)
    await expect(registry.list()).rejects.toThrow()
    await chmod(statePath, 0o600)
    expect(await registry.list()).toHaveLength(2)
  })
})
