import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  handle,
  mkdir,
  readFile,
  writeFile,
  rename,
  unlink,
} = vi.hoisted(() => ({
  handle: vi.fn(),
  mkdir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  rename: vi.fn(),
  unlink: vi.fn(),
}))

vi.mock('electron', () => ({ ipcMain: { handle } }))
vi.mock('fs/promises', () => ({ mkdir, readFile, writeFile, rename, unlink }))
vi.mock('@main/storage/paths.js', () => ({
  STATE_DIR: '/recorded/state',
  STATE_FILE: '/recorded/state/workspace.json',
}))

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(res => {
    resolve = res
  })
  return { promise, resolve }
}

describe('workspace persistence ordering', () => {
  beforeEach(() => {
    handle.mockReset()
    mkdir.mockReset().mockResolvedValue(undefined)
    readFile.mockReset()
    writeFile.mockReset()
    rename.mockReset()
    unlink.mockReset().mockResolvedValue(undefined)
  })

  it('commits overlapping saves in IPC admission order', async () => {
    const firstWriteGate = deferred()
    const tempContents = new Map<string, string>()
    const acknowledgements: string[][] = []
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

    const { registerWorkspaceIpc } = await import('./workspace')
    registerWorkspaceIpc({
      acknowledgePersistedSessionOwnership: (sessionIds: ReadonlySet<string>) => {
        acknowledgements.push([...sessionIds])
      },
    } as never)
    const save = handle.mock.calls.find(([channel]) => channel === 'workspace:save')?.[1] as
      | ((_event: unknown, json: string) => Promise<void>)
      | undefined
    expect(save).toBeTypeOf('function')

    const firstJson = JSON.stringify({ workspace: { sessions: { predecessor: {} } } })
    const secondJson = JSON.stringify({ workspace: { sessions: { successor: {} } } })
    const firstSave = save?.({}, firstJson)
    await vi.waitFor(() => expect(writeFile).toHaveBeenCalledTimes(1))
    const secondSave = save?.({}, secondJson)

    // WHY inspect the blocked boundary before releasing it: the production
    // failure needs no corrupt temp file. Unique scratch paths let save B race
    // past delayed save A, after which A can overwrite the newer renderer
    // snapshot and acknowledge ownership in the wrong order.
    await Promise.resolve()
    await Promise.resolve()
    const writesBeforeRelease = writeFile.mock.calls.length
    firstWriteGate.resolve()
    await Promise.all([firstSave, secondSave])

    expect(writesBeforeRelease).toBe(1)
    expect(durableContents).toBe(secondJson)
    expect(acknowledgements).toEqual([
      ['predecessor'],
      ['successor'],
    ])
  })

  it('does not let reload read bytes older than an admitted save', async () => {
    const writeGate = deferred()
    const savedJson = JSON.stringify({
      workspace: { sessions: { successor: {} } },
    })
    writeFile.mockImplementationOnce(async () => await writeGate.promise)
    rename.mockResolvedValue(undefined)
    readFile.mockResolvedValue(savedJson)

    const { registerWorkspaceIpc } = await import('./workspace')
    registerWorkspaceIpc({
      acknowledgePersistedSessionOwnership: vi.fn(),
    } as never)
    const save = handle.mock.calls.find(([channel]) => channel === 'workspace:save')?.[1] as
      | ((_event: unknown, json: string) => Promise<void>)
      | undefined
    const load = handle.mock.calls.find(([channel]) => channel === 'workspace:load')?.[1] as
      | (() => Promise<string | null>)
      | undefined
    expect(save).toBeTypeOf('function')
    expect(load).toBeTypeOf('function')

    const saving = save?.({}, savedJson)
    await vi.waitFor(() => expect(writeFile).toHaveBeenCalledTimes(1))
    const loading = load?.()
    await Promise.resolve()
    await Promise.resolve()
    const readsBeforeSaveSettles = readFile.mock.calls.length

    writeGate.resolve()
    await expect(saving).resolves.toBeUndefined()
    await expect(loading).resolves.toBe(savedJson)

    // A renderer created after unload-save admission must see that save or a
    // later one. Reading the previous predecessor bytes here can start reclaim
    // while the blocked rename is about to durably acknowledge the killed
    // successor, leaving disk and main with opposite owners.
    expect(readsBeforeSaveSettles).toBe(0)
    expect(readFile).toHaveBeenCalledTimes(1)
  })

  it('removes its unique temp file when the atomic rename rejects', async () => {
    const recordedFailure = new Error('recorded rename rejection')
    writeFile.mockResolvedValue(undefined)
    rename.mockRejectedValue(recordedFailure)

    const { registerWorkspaceIpc } = await import('./workspace')
    registerWorkspaceIpc({
      acknowledgePersistedSessionOwnership: vi.fn(),
    } as never)
    const save = handle.mock.calls.find(([channel]) => channel === 'workspace:save')?.[1] as
      | ((_event: unknown, json: string) => Promise<void>)
      | undefined
    expect(save).toBeTypeOf('function')

    await expect(save?.({}, JSON.stringify({
      workspace: { sessions: { successor: {} } },
    }))).rejects.toBe(recordedFailure)

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
})
