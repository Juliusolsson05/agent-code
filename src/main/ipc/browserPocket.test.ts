import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

import type { PortWatchSession } from '@shared/browserPocket/types.js'

// Review round 2, A #7: every window submits the watch plan for its own
// workspace, and the single app-wide watcher used to take whichever window
// spoke last. This drives the real IPC handler with two fake windows.

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
const guests = vi.hoisted(() => new Map<number, unknown>())
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => { handlers.set(channel, handler) } },
  webContents: { fromId: (id: number) => guests.get(id) ?? null },
}))

const { mergeWatchPlans, registerBrowserPocketIpc } = await import('./browserPocket')

const plan = (...ids: string[]): PortWatchSession[] => ids.map(sessionId => ({ sessionId, tmuxNames: [], ptyPids: [] }) as unknown as PortWatchSession)
const window = (id: number) => Object.assign(new EventEmitter(), { id })

describe('browser-pocket:set-watch', () => {
  it('scans the union of every window\'s plan and drops a closed window\'s plan', () => {
    const watched: string[][] = []
    registerBrowserPocketIpc({ setWatchedSessions: (s: PortWatchSession[]) => watched.push(s.map(x => x.sessionId)) } as never)
    const setWatch = handlers.get('browser-pocket:set-watch')!
    const a = window(1)
    const b = window(2)
    setWatch({ sender: a }, { sessions: plan('s1', 's2') })
    // An empty second window must not clear the first window's lanes.
    setWatch({ sender: b }, { sessions: [] })
    expect(watched.at(-1)).toEqual(['s1', 's2'])
    setWatch({ sender: b }, { sessions: plan('s3') })
    expect(watched.at(-1)).toEqual(['s1', 's2', 's3'])
    a.emit('destroyed')
    expect(watched.at(-1)).toEqual(['s3'])
  })

  it('never lists one session twice', () => {
    expect(mergeWatchPlans([plan('s1', 's2'), plan('s2', 's3')]).map(s => s.sessionId)).toEqual(['s1', 's2', 's3'])
  })
})

// #1481 review: a pocket id moves with its session to another window. The
// target registers a new guest under that id; the source then retires its old
// guest and unregisters the same id. That must not delete the target's live
// registration.
describe('browser-pocket:unregister-guest', () => {
  it('ignores an unregister from a renderer that no longer holds the registration', async () => {
    const unregister = vi.fn(async () => undefined)
    const register = vi.fn()
    registerBrowserPocketIpc({ register, unregister, noteHumanInput: vi.fn(), agentTyping: vi.fn() } as never)
    const handle = (channel: string) => handlers.get(channel)!
    const source = window(10)
    const target = window(20)
    // A guest webContents embedded by each renderer.
    const guest = (id: number, host: { id: number }) => Object.assign(new EventEmitter(), {
      id, hostWebContents: host, getType: () => 'webview', isDestroyed: () => false,
      on: () => undefined, setWindowOpenHandler: () => undefined,
    })
    guests.set(1, guest(1, source))
    guests.set(2, guest(2, target))

    const sourceRegistered = await handle('browser-pocket:register-guest')({ sender: source }, { pocketId: 'p', sessionId: 's', webContentsId: 1 })
    const targetRegistered = await handle('browser-pocket:register-guest')({ sender: target }, { pocketId: 'p', sessionId: 's', webContentsId: 2 })
    // Both registrations must be admitted for this test to mean anything.
    expect([sourceRegistered, targetRegistered]).toEqual([{ ok: true }, { ok: true }])

    await handle('browser-pocket:unregister-guest')({ sender: source }, { pocketId: 'p' })
    expect(unregister).not.toHaveBeenCalled()

    await handle('browser-pocket:unregister-guest')({ sender: target }, { pocketId: 'p' })
    expect(unregister).toHaveBeenCalledWith('p')
  })
})
