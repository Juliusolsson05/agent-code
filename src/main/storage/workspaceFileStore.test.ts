import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mkdir, readFile, writeFile, rename, unlink } = vi.hoisted(() => ({
  mkdir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  rename: vi.fn(),
  unlink: vi.fn(),
}))

vi.mock('fs/promises', () => ({ mkdir, readFile, writeFile, rename, unlink }))
vi.mock('@main/storage/paths.js', () => ({
  STATE_DIR: '/recorded/state',
  STATE_FILE: '/recorded/state/workspace.json',
}))

const { WorkspaceFileStore } = await import('@main/storage/workspaceFileStore.js')

// Durability discipline for workspace.json.
//
// The ordering and cleanup cases here were written against the previous
// byte-mover implementation in ipc/workspace.ts and moved with the behavior:
// the failures they pin (a delayed save renaming after a newer one; an
// interrupted rename leaking scratch files) are properties of the write queue,
// not of where it lives. The per-window cases are new.

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(res => { resolve = res })
  return { promise, resolve }
}

const NO_GEOMETRY = { bounds: null, displayId: null, fullScreen: false }

function enoent(): NodeJS.ErrnoException {
  const error = new Error('no workspace file') as NodeJS.ErrnoException
  error.code = 'ENOENT'
  return error
}

function slice(sessions: string[]): string {
  return JSON.stringify({
    workspace: { sessions: Object.fromEntries(sessions.map(id => [id, { cwd: `/${id}` }])) },
  })
}

describe('workspace persistence ordering', () => {
  beforeEach(() => {
    mkdir.mockReset().mockResolvedValue(undefined)
    readFile.mockReset().mockRejectedValue(enoent())
    writeFile.mockReset().mockResolvedValue(undefined)
    rename.mockReset().mockResolvedValue(undefined)
    unlink.mockReset().mockResolvedValue(undefined)
  })

  it('commits overlapping saves in admission order', async () => {
    const firstWriteGate = deferred()
    const tempContents = new Map<string, string>()
    let durableContents = ''
    let writeCount = 0

    writeFile.mockImplementation(async (file: string, contents: string) => {
      writeCount += 1
      if (writeCount === 1) await firstWriteGate.promise
      tempContents.set(file, contents)
    })
    rename.mockImplementation(async (source: string) => {
      durableContents = tempContents.get(source) ?? ''
    })

    const store = await WorkspaceFileStore.open()
    const firstSave = store.saveSlice('w1', slice(['predecessor']), NO_GEOMETRY)
    await vi.waitFor(() => expect(writeFile).toHaveBeenCalledTimes(1))
    const secondSave = store.saveSlice('w1', slice(['successor']), NO_GEOMETRY)

    // WHY inspect the blocked boundary before releasing it: the production
    // failure needs no corrupt temp file. Unique scratch paths let save B race
    // past delayed save A, after which A can overwrite the newer renderer
    // snapshot.
    await Promise.resolve()
    await Promise.resolve()
    const writesBeforeRelease = writeFile.mock.calls.length
    firstWriteGate.resolve()
    await Promise.all([firstSave, secondSave])

    expect(writesBeforeRelease).toBe(1)
    expect(JSON.parse(durableContents).windows[0].workspace.sessions).toEqual({
      successor: { cwd: '/successor' },
    })
  })

  it('does not let a load resolve with bytes older than an admitted save', async () => {
    const writeGate = deferred()
    writeFile.mockImplementationOnce(async () => await writeGate.promise)

    const store = await WorkspaceFileStore.open()
    const saving = store.saveSlice('w1', slice(['successor']), NO_GEOMETRY)
    await vi.waitFor(() => expect(writeFile).toHaveBeenCalledTimes(1))

    let loadSettled = false
    const loading = store.loadSlice('w1').then(value => {
      loadSettled = true
      return value
    })
    await Promise.resolve()
    await Promise.resolve()
    // A renderer created after unload-save admission must see that save or a
    // later one. Resolving with predecessor bytes here can start reclaim while
    // the blocked rename is about to durably commit the killed successor,
    // leaving disk and main with opposite owners.
    expect(loadSettled).toBe(false)

    writeGate.resolve()
    await expect(saving).resolves.toBeUndefined()
    await expect(loading).resolves.toBe(slice(['successor']))
  })

  it('removes its unique temp file when the atomic rename rejects', async () => {
    const recordedFailure = new Error('recorded rename rejection')
    rename.mockRejectedValue(recordedFailure)

    const store = await WorkspaceFileStore.open()
    await expect(store.saveSlice('w1', slice(['successor']), NO_GEOMETRY))
      .rejects.toBe(recordedFailure)

    const tempPath = writeFile.mock.calls[0]?.[0]
    expect(tempPath).toMatch(/^\/recorded\/state\/workspace\.json\./)
    // WHY assert the exact nonce path rather than merely "unlink happened":
    // concurrent admitted saves each own a different scratch artifact. Broad
    // cleanup or recomputing the name could delete another generation's file.
    expect(unlink).toHaveBeenCalledWith(tempPath)
    expect(unlink.mock.invocationCallOrder[0]).toBeGreaterThan(
      rename.mock.invocationCallOrder[0],
    )
  })

  it('keeps the last durable document when a write fails mid-sequence', async () => {
    const store = await WorkspaceFileStore.open()
    await store.saveSlice('w1', slice(['committed']), NO_GEOMETRY)

    rename.mockRejectedValueOnce(new Error('transient'))
    await expect(store.saveSlice('w1', slice(['lost']), NO_GEOMETRY)).rejects.toThrow('transient')

    // WHY this matters: the in-memory document is what the NEXT save is
    // composed against. If a failed write advanced it, the retry would commit a
    // document whose other windows were merged against bytes that never
    // reached disk.
    await expect(store.loadSlice('w1')).resolves.toBe(slice(['committed']))
  })
})

describe('per-window isolation on disk', () => {
  beforeEach(() => {
    mkdir.mockReset().mockResolvedValue(undefined)
    writeFile.mockReset().mockResolvedValue(undefined)
    rename.mockReset().mockResolvedValue(undefined)
    unlink.mockReset().mockResolvedValue(undefined)
    readFile.mockReset().mockResolvedValue(JSON.stringify({
      version: 2,
      windows: [
        { windowId: 'left', workspace: { sessions: { 'left-agent': {} } } },
        { windowId: 'right', workspace: { sessions: { 'right-agent': {} } } },
      ],
    }))
  })

  it('one window saving cannot prune the other window out of the file', async () => {
    // This is the regression that would eat agents. `useAutoSave` deliberately
    // drops sessions it cannot prove are owned, and the left window's serialized
    // state contains no evidence for `right-agent` — it has never seen it. A
    // whole-file save from either side would delete the other's work every
    // 400ms, in both directions.
    const store = await WorkspaceFileStore.open()
    const written: string[] = []
    writeFile.mockImplementation(async (_file: string, contents: string) => {
      written.push(contents)
    })

    await store.saveSlice('left', slice(['left-agent', 'left-second']), NO_GEOMETRY)

    const document = JSON.parse(written.at(-1)!)
    expect(document.windows).toHaveLength(2)
    expect(document.windows.find((w: { windowId: string }) => w.windowId === 'right').workspace)
      .toEqual({ sessions: { 'right-agent': {} } })
    expect([...store.sessionIds()].sort()).toEqual(
      ['left-agent', 'left-second', 'right-agent'],
    )
  })

  it('restores every persisted window', async () => {
    const store = await WorkspaceFileStore.open()
    expect(store.windows().map(w => w.windowId)).toEqual(['left', 'right'])
  })
})

describe('refusing to write over a file it could not read', () => {
  beforeEach(() => {
    mkdir.mockReset().mockResolvedValue(undefined)
    writeFile.mockReset().mockResolvedValue(undefined)
    rename.mockReset().mockResolvedValue(undefined)
    unlink.mockReset().mockResolvedValue(undefined)
  })

  it('rejects saves when the file is a newer format', async () => {
    readFile.mockReset().mockResolvedValue(JSON.stringify({ version: 99, windows: [] }))
    const store = await WorkspaceFileStore.open()

    expect(store.isReadOnly()).toBe(true)
    await expect(store.saveSlice('w1', slice(['a']), NO_GEOMETRY)).rejects.toThrow(/version 99/)
    // The user's file must still be intact after a downgrade launch: nothing
    // was written at all, not even an empty document.
    expect(writeFile).not.toHaveBeenCalled()
  })

  it('rejects a save whose payload is not a workspace envelope', async () => {
    readFile.mockReset().mockRejectedValue(enoent())
    const store = await WorkspaceFileStore.open()
    // A slice has to be placed inside a document other windows share, so
    // unparseable bytes cannot be stored verbatim the way the old byte mover
    // did. Failing loudly is what stops a window believing it is durable.
    await expect(store.saveSlice('w1', 'not json at all', NO_GEOMETRY)).rejects.toThrow()
    expect(writeFile).not.toHaveBeenCalled()
  })
})
