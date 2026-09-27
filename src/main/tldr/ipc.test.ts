import { describe, expect, it, vi } from 'vitest'

import type { TldrStore } from './TldrStore.js'
import type { TldrEnforcement } from './enforcement.js'

// vi.hoisted, because vi.mock factories are hoisted above ordinary consts.
const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => { handlers.set(channel, handler) },
    on: () => {},
  },
  systemPreferences: {},
}))
vi.mock('@main/window/windowRegistry.js', () => ({
  windowIdFor: () => 'window-one',
  getBrowserWindow: () => ({ id: 1 }),
  broadcastToWindows: () => {},
}))
vi.mock('@main/dictation/macHotkeyHelper.js', () => ({ ensureMacHotkeyHelperBinary: async () => null }))
vi.mock('./holdRelease.js', () => ({ watchMacTldrRelease: () => () => {} }))

const { registerGoalIpc, registerTldrIpc } = await import('./ipc.js')

function fakes() {
  const read = vi.fn(async (identities: string[]) => Object.fromEntries(identities.map(id => [id, { text: `tldr of ${id}` }])))
  const status = vi.fn((identities: string[]) => Object.fromEntries(identities.map(id => [id, 'active'])))
  const history = vi.fn(async (identity: string) => [{ identity }])
  const store = { read, history, on: () => {} } as unknown as TldrStore
  const enforcement = { status } as unknown as Pick<TldrEnforcement, 'status'>
  return { store, enforcement, read, status, history }
}

const sender = { mainFrame: {} }
const event = { sender, senderFrame: sender.mainFrame }

describe('TLDR read IPC batches (#1251 row 12)', () => {
  // One identity outside the stored-identity alphabet used to fail zod's
  // array parse, so Agent Activity's single batched read rejected and every
  // TLDR (and goal) on screen went blank. A TLDR can only ever be written under
  // a valid identity (the MCP writer validates the same predicate), so an
  // invalid one has no record to return: dropping it from the batch answers it
  // exactly as the store would, "none", without taking the rest down.
  it('answers the valid identities of a batch that also holds an invalid one', async () => {
    const { store, enforcement, read, status } = fakes()
    registerTldrIpc(store, enforcement)
    registerGoalIpc(store)
    const batch = ['session-1', 'not a/valid identity', 'session-2']

    await expect(handlers.get('tldr:read')!(event, batch)).resolves.toEqual({
      'session-1': { text: 'tldr of session-1' },
      'session-2': { text: 'tldr of session-2' },
    })
    expect(read).toHaveBeenLastCalledWith(['session-1', 'session-2'])
    await handlers.get('goal:read')!(event, batch)
    expect(read).toHaveBeenLastCalledWith(['session-1', 'session-2'])
    await handlers.get('tldr:enforcement')!(event, batch)
    expect(status).toHaveBeenLastCalledWith(['session-1', 'session-2'])
  })

  it('still refuses a payload that is not a bounded list of strings', async () => {
    const { store, enforcement } = fakes()
    registerTldrIpc(store, enforcement)
    expect(() => handlers.get('tldr:read')!(event, 'session-1')).toThrow()
    expect(() => handlers.get('tldr:read')!(event, [42])).toThrow()
    expect(() => handlers.get('tldr:read')!(event, Array.from({ length: 10_001 }, (_, i) => `s${i}`))).toThrow()
    expect(() => handlers.get('tldr:read')!(event, ['x'.repeat(100_000)])).toThrow()
  })

  it('answers history for an invalid identity with an empty list, as the batch reads do', async () => {
    const { store, enforcement, history } = fakes()
    registerTldrIpc(store, enforcement)
    registerGoalIpc(store)
    for (const channel of ['tldr:history', 'goal:history']) {
      await expect(handlers.get(channel)!(event, 'not a/valid identity')).resolves.toEqual([])
      await expect(handlers.get(channel)!(event, 'session-1')).resolves.toEqual([{ identity: 'session-1' }])
      expect(() => handlers.get(channel)!(event, 42)).toThrow()
    }
    expect(history).toHaveBeenCalledTimes(2)
  })
})
