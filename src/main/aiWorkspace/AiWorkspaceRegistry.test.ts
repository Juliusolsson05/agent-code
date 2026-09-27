import { mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'

import { AI_WORKSPACE_STATUS_NOT_SAVED, AI_WORKSPACE_STORAGE_BLOCKED, AiWorkspaceRegistry } from './AiWorkspaceRegistry.js'

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
    const { root, registry } = await registryFor(state)
    const listed = (await registry.list()).find(workspace => workspace.workspaceId === state.workspaces[0]!.workspaceId)!
    expect(listed).not.toHaveProperty('description')
    const opened = (await registry.get(state.workspaces[0]!.workspaceId))!
    expect(opened.entries[0]).not.toHaveProperty('projectRoot')
    expect(opened.entries[0]!.title).toBe('file-0.md')
    // A valid description elsewhere is untouched (round 2: a repair that
    // dropped every description survived).
    const other = (await registry.list()).find(workspace => workspace.workspaceId === state.workspaces[1]!.workspaceId)!
    expect(other.description).toBe(state.workspaces[1]!.description)
    // The repaired values are preserved before the save that drops them.
    await registry.create({ name: 'After repair' })
    const { readdir, readFile: read } = await import('fs/promises')
    const copies = (await readdir(root)).filter(name => name.startsWith('ai-workspaces.json.invalid-'))
    expect(copies).toHaveLength(1)
    expect(JSON.parse(await read(join(root, copies[0]!), 'utf8')).workspaces[0].description).toEqual({ not: 'text' })
  })

  it.each([
    ['an entry field', (state: { workspaces: Array<Record<string, any>> }) => { state.workspaces[0]!.entries[0].title = 9 }],
    ['a workspace field', (state: { workspaces: Array<Record<string, any>> }) => { state.workspaces[0]!.description = { not: 'text' } }],
  ])('preserves the original before a save drops a repaired %s', async (_label, damage) => {
    const state = await realState()
    damage(state)
    const { root, source, registry } = await registryFor(state)
    await registry.create({ name: 'After repair' })
    const { readdir, readFile: read } = await import('fs/promises')
    const copies = (await readdir(root)).filter(name => name.startsWith('ai-workspaces.json.invalid-'))
    expect(await Promise.all(copies.map(name => read(join(root, name), 'utf8')))).toEqual([source])
  })

  it('does not keep a workspace in memory whose create was refused (round 2)', async () => {
    const state = await realState()
    state.workspaces[1]!.updatedAt = 1789000000
    const { root, source, registry } = await registryFor(state)
    const { createHash } = await import('node:crypto')
    const { mkdir } = await import('fs/promises')
    const occupied = join(root, `ai-workspaces.json.invalid-${createHash('sha256').update(source).digest('hex').slice(0, 16)}.json`)
    await mkdir(occupied)
    await expect(registry.create({ name: 'Blocked' })).rejects.toThrow()
    expect((await registry.list()).map(workspace => workspace.name)).not.toContain('Blocked')
    await rm(occupied, { recursive: true })
    await registry.create({ name: 'Blocked' })
    const reopened = new AiWorkspaceRegistry(join(root, 'ai-workspaces.json'))
    expect((await reopened.list()).map(workspace => workspace.name)).toContain('Blocked')
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

// #1285 (residual of #1260 review B, round 2): the registry owes a
// preservation copy of rows it could not read, and that copy is blocked (a
// directory sits on its path). The user's file write succeeds; only the status
// refresh that follows it, which saves state and so must make the owed copy
// first, fails. Reporting the WRITE as failed told the editor (and an agent)
// that the edit had not landed when it had.
//
// The state is the REAL recorded registry (two workspaces from the owner's
// ai-workspaces.json). Its paths are redacted, so one real entry is pointed at
// a temp file; one real workspace is made malformed, exactly as the #1260
// owed-copy tests do, so a copy is owed.
describe('a write whose status refresh cannot be saved (#1285)', () => {
  it('reports the write as done, with a warning, when only the status save fails', async () => {
    const recorded = JSON.parse(await readFile(join(import.meta.dirname,
      '../../../testing/fixtures/ai-workspace/real-workspaces-2026-09-25.json'), 'utf8')) as {
      state: { workspaces: Array<Record<string, any>> }
    }
    const state = recorded.state
    const root = await mkdtemp(join(tmpdir(), 'agent-code-ai-workspace-owed-'))
    tempRoots.push(root)
    const filePath = join(root, 'attached.txt')
    await writeFile(filePath, 'v1')
    state.workspaces[0]!.entries[0]!.path = filePath
    state.workspaces[0]!.entries[0]!.projectRoot = root
    state.workspaces[1]!.updatedAt = 1789000000
    const statePath = join(root, 'ai-workspaces.json')
    const source = JSON.stringify(state)
    await writeFile(statePath, source)
    const { createHash } = await import('node:crypto')
    const { mkdir } = await import('fs/promises')
    await mkdir(join(root, `ai-workspaces.json.invalid-${createHash('sha256').update(source).digest('hex').slice(0, 16)}.json`))

    const registry = new AiWorkspaceRegistry(statePath)
    const target = await realpath(filePath)
    const result = await registry.writeFile({ path: target, text: 'v2' })

    // The write landed, and the result says so, with the status failure as a
    // warning rather than as the outcome.
    expect(await readFile(target, 'utf8')).toBe('v2')
    expect(result).toMatchObject({ ok: true, path: target })
    expect((result as { warning?: string }).warning).toBe(AI_WORKSPACE_STATUS_NOT_SAVED)
    // The file stays fully usable: it reads back through the registry.
    expect(await registry.readFile(target)).toMatchObject({ ok: true, text: 'v2' })
    // The stored state was not rewritten: the owed copy still blocks saves.
    expect(await readFile(statePath, 'utf8')).toBe(source)
    // A refused save says why and how to unblock it, not the raw errno text.
    const refusal = await registry.create({ name: 'Blocked' }).then(() => null, (err: Error) => err.message)
    expect(refusal).toMatch(/needs attention.*\(EISDIR\).*already occupies the copy path/s)
    // Only the code, never the raw filesystem message.
    expect(refusal).not.toMatch(/illegal operation|is a directory/i)

    // #1416 review b: every LOAD reports the blocked storage, so an editor
    // that remounts (a workspace switch) still shows it.
    const workspaceId = state.workspaces[0]!.workspaceId as string
    expect((await registry.get(workspaceId))?.storageWarning).toBe(AI_WORKSPACE_STORAGE_BLOCKED)
    // Unblocked: the next save writes the copy and the notice clears.
    await rm(join(root, `ai-workspaces.json.invalid-${createHash('sha256').update(source).digest('hex').slice(0, 16)}.json`), { recursive: true })
    await registry.create({ name: 'Now' })
    expect((await registry.get(workspaceId))?.storageWarning).toBeUndefined()
    // It was never persisted.
    expect(await readFile(statePath, 'utf8')).not.toContain('storageWarning')
  })

  it('keeps reporting an unsaved status when the copy succeeds but the state write fails', async () => {
    // #1416 verification b: copy blocked, then unblocked, then the state file
    // itself cannot be written (its path became a directory). copyBlocked is
    // false by then, so `get` must still report the unsaved status until a
    // state save really succeeds.
    const recorded = JSON.parse(await readFile(join(import.meta.dirname,
      '../../../testing/fixtures/ai-workspace/real-workspaces-2026-09-25.json'), 'utf8')) as {
      state: { workspaces: Array<Record<string, any>> }
    }
    const state = recorded.state
    const root = await mkdtemp(join(tmpdir(), 'agent-code-ai-workspace-statewrite-'))
    tempRoots.push(root)
    const filePath = join(root, 'attached.txt')
    await writeFile(filePath, 'v1')
    state.workspaces[0]!.entries[0]!.path = filePath
    state.workspaces[0]!.entries[0]!.projectRoot = root
    state.workspaces[1]!.updatedAt = 1789000000
    const statePath = join(root, 'ai-workspaces.json')
    const source = JSON.stringify(state)
    await writeFile(statePath, source)
    const { createHash } = await import('node:crypto')
    const { mkdir } = await import('fs/promises')
    const copyPath = join(root, `ai-workspaces.json.invalid-${createHash('sha256').update(source).digest('hex').slice(0, 16)}.json`)
    await mkdir(copyPath)
    const registry = new AiWorkspaceRegistry(statePath)
    const workspaceId = state.workspaces[0]!.workspaceId as string
    expect((await registry.get(workspaceId))?.storageWarning).toBe(AI_WORKSPACE_STORAGE_BLOCKED)

    await rm(copyPath, { recursive: true })
    await rm(statePath)
    await mkdir(statePath)
    const target = await realpath(filePath)
    const result = await registry.writeFile({ path: target, text: 'v2' })
    expect(result).toMatchObject({ ok: true, warning: AI_WORKSPACE_STATUS_NOT_SAVED })
    expect(await readFile(copyPath, 'utf8')).toBe(source)
    expect((await registry.get(workspaceId))?.storageWarning).toBe(AI_WORKSPACE_STATUS_NOT_SAVED)

    // Once the state file can be written again, a save clears it.
    await rm(statePath, { recursive: true })
    await registry.create({ name: 'Now' })
    expect((await registry.get(workspaceId))?.storageWarning).toBeUndefined()
  })

  it('gives no warning on an ordinary write, and a throwing listener does not fail it', async () => {
    // #1416 review a: a throwing `changed` listener (the production one
    // broadcasts to every window) turned a landed write into `ok: false`,
    // and stopped the second workspace hearing about it.
    const { registry, filePath } = await registryWithAttachedFile('v1')
    await registry.list()
    const heard: string[] = []
    registry.on('changed', (event: { workspaceId: string }) => {
      heard.push(event.workspaceId)
      throw new Error('event delivery failed')
    })
    const result = await registry.writeFile({ path: filePath, text: 'v2' })
    expect(result).toMatchObject({ ok: true })
    expect(result).not.toHaveProperty('warning')
    expect(await readFile(filePath, 'utf8')).toBe('v2')
    expect(heard).toEqual(['workspace-1'])
  })

  it('tells every workspace holding the file, even when the first listener call throws', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-code-ai-workspace-fanout-'))
    tempRoots.push(root)
    const filePath = join(root, 'shared.txt')
    await writeFile(filePath, 'v1')
    const entry = (entryId: string) => ({
      entryId, path: filePath, projectRoot: root, title: 'shared.txt', attachedAt: '2026-01-01T00:00:00.000Z',
      status: { exists: true, readable: true, staleReason: null, size: 2, mtimeMs: null },
    })
    const workspace = (workspaceId: string) => ({
      workspaceId, name: workspaceId, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', entries: [entry(`${workspaceId}-e`)],
    })
    const statePath = join(root, 'ai-workspaces.json')
    await writeFile(statePath, JSON.stringify({ workspaces: [workspace('ws-a'), workspace('ws-b')] }))
    const registry = new AiWorkspaceRegistry(statePath)
    await registry.list()
    const heard: string[] = []
    registry.on('changed', (event: { workspaceId: string }) => {
      heard.push(event.workspaceId)
      throw new Error('event delivery failed')
    })
    const result = await registry.writeFile({ path: await realpath(filePath), text: 'v2' })
    expect(result).toMatchObject({ ok: true })
    expect(heard.sort()).toEqual(['ws-a', 'ws-b'])
  })

  it('gives advice that matches the cause when the owed copy cannot be written', async () => {
    // A missing state folder is not "something occupies the path".
    const root = await mkdtemp(join(tmpdir(), 'agent-code-ai-workspace-enoent-'))
    tempRoots.push(root)
    const stateDir = join(root, 'state')
    const { mkdir } = await import('fs/promises')
    await mkdir(stateDir)
    const statePath = join(stateDir, 'ai-workspaces.json')
    const source = JSON.stringify({ workspaces: [null] })
    await writeFile(statePath, source)
    const { createHash } = await import('node:crypto')
    await mkdir(join(stateDir, `ai-workspaces.json.invalid-${createHash('sha256').update(source).digest('hex').slice(0, 16)}.json`))
    const registry = new AiWorkspaceRegistry(statePath)
    await registry.list()
    await rm(stateDir, { recursive: true })
    await expect(registry.create({ name: 'Blocked' })).rejects.toThrow(/\(ENOENT\).*folder holding .* is missing/s)
  })
})
