import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handle, windowIdFor, getBrowserWindow } = vi.hoisted(() => ({
  handle: vi.fn(),
  windowIdFor: vi.fn(),
  getBrowserWindow: vi.fn(),
}))

vi.mock('electron', () => ({
  ipcMain: { handle },
  screen: { getDisplayMatching: () => ({ id: 1 }) },
}))
vi.mock('@main/window/windowRegistry.js', () => ({ windowIdFor, getBrowserWindow }))

const { registerWorkspaceIpc } = await import('@main/ipc/workspace.js')

// The addressing layer: which window a workspace payload belongs to, and what
// main tells SessionManager afterwards.
//
// The durability ordering itself is pinned in workspaceFileStore.test.ts. What
// is asserted here is the part that only exists because there are windows.

type SaveHandler = (event: { sender: unknown }, json: string) => Promise<void>
type LoadHandler = (event: { sender: unknown }) => Promise<string | null>

function handlerFor(channel: string): (...args: never[]) => Promise<unknown> {
  const entry = handle.mock.calls.find(([name]) => name === channel)
  if (!entry) throw new Error(`no handler registered for ${channel}`)
  return entry[1] as (...args: never[]) => Promise<unknown>
}

function fakeStore(overrides: Partial<{
  saveSlice: (windowId: string, json: string, geometry: unknown) => Promise<void>
  loadSlice: (windowId: string) => Promise<string | null>
  sessionIds: () => Set<string>
}> = {}) {
  return {
    saveSlice: overrides.saveSlice ?? vi.fn(async () => undefined),
    loadSlice: overrides.loadSlice ?? vi.fn(async () => null),
    sessionIds: overrides.sessionIds ?? (() => new Set<string>()),
  }
}

describe('workspace IPC addressing', () => {
  beforeEach(() => {
    handle.mockReset()
    windowIdFor.mockReset()
    getBrowserWindow.mockReset().mockReturnValue(null)
  })

  it('writes a payload into the slice of the window that sent it', async () => {
    windowIdFor.mockImplementation((sender: { id: number }) =>
      sender.id === 1 ? 'left' : 'right')
    const store = fakeStore()
    registerWorkspaceIpc({ acknowledgePersistedSessionOwnership: vi.fn() } as never, store as never)
    const save = handlerFor('workspace:save') as unknown as SaveHandler

    await save({ sender: { id: 1 } }, '{"workspace":{}}')
    await save({ sender: { id: 2 } }, '{"workspace":{}}')

    expect((store.saveSlice as ReturnType<typeof vi.fn>).mock.calls.map(call => call[0]))
      .toEqual(['left', 'right'])
  })

  it('acknowledges the union of every window rather than one window s sessions', async () => {
    // WHY the union: `acknowledgePersistedSessionOwnership` answers a
    // process-wide question — which local ids has SOME renderer made durable.
    // Handing it one window's ids would tell the manager that another window's
    // live, persisted sessions are unclaimed, and main would be free to reclaim
    // or stop them.
    windowIdFor.mockReturnValue('left')
    const acknowledged: string[][] = []
    const store = fakeStore({ sessionIds: () => new Set(['left-agent', 'right-agent']) })
    registerWorkspaceIpc({
      acknowledgePersistedSessionOwnership: (ids: ReadonlySet<string>) => {
        acknowledged.push([...ids].sort())
      },
    } as never, store as never)

    await (handlerFor('workspace:save') as unknown as SaveHandler)(
      { sender: { id: 1 } },
      '{"workspace":{}}',
    )

    expect(acknowledged).toEqual([['left-agent', 'right-agent']])
  })

  it('acknowledges in save admission order', async () => {
    // The predecessor/successor handoff depends on main acknowledging the
    // NEWEST committed ownership last. Because each handler awaits its own save
    // and the store serializes them, the acknowledgements inherit that order —
    // this pins the property so a future "acknowledge eagerly, save in the
    // background" refactor fails here rather than in a session handoff.
    windowIdFor.mockReturnValue('left')
    const order: string[] = []
    const gate = { release: () => {} }
    const blocked = new Promise<void>(resolve => { gate.release = resolve })
    let first = true
    const store = fakeStore({
      saveSlice: vi.fn(async () => {
        if (first) {
          first = false
          await blocked
        }
      }),
      sessionIds: () => new Set([order.length === 0 ? 'predecessor' : 'successor']),
    })
    registerWorkspaceIpc({
      acknowledgePersistedSessionOwnership: (ids: ReadonlySet<string>) => {
        order.push([...ids][0]!)
      },
    } as never, store as never)
    const save = handlerFor('workspace:save') as unknown as SaveHandler

    const a = save({ sender: { id: 1 } }, '{"workspace":{}}')
    const b = save({ sender: { id: 1 } }, '{"workspace":{}}')
    gate.release()
    await Promise.all([a, b])

    expect(order).toEqual(['predecessor', 'successor'])
  })

  it('rejects a save from a sender that owns no window', async () => {
    // WHY reject rather than fall back to some window: a save with no
    // defensible destination would otherwise overwrite a real window's
    // workspace with a stranger's. Autosave already surfaces and retries save
    // failures, so the renderer is not left believing it is durable.
    windowIdFor.mockReturnValue(null)
    const store = fakeStore()
    registerWorkspaceIpc({ acknowledgePersistedSessionOwnership: vi.fn() } as never, store as never)

    await expect(
      (handlerFor('workspace:save') as unknown as SaveHandler)(
        { sender: { id: 9 } },
        '{"workspace":{}}',
      ),
    ).rejects.toThrow(/owns no window/)
    expect(store.saveSlice).not.toHaveBeenCalled()
  })

  it('loads nothing for a sender that owns no window', async () => {
    windowIdFor.mockReturnValue(null)
    const store = fakeStore({ loadSlice: vi.fn(async () => '{"workspace":{}}') })
    registerWorkspaceIpc({ acknowledgePersistedSessionOwnership: vi.fn() } as never, store as never)

    await expect(
      (handlerFor('workspace:load') as unknown as LoadHandler)({ sender: { id: 9 } }),
    ).resolves.toBeNull()
    expect(store.loadSlice).not.toHaveBeenCalled()
  })
})
