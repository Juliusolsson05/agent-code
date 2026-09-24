import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

import type { PortWatchSession } from '@shared/browserPocket/types.js'

// Review round 2, A #7: every window submits the watch plan for its own
// workspace, and the single app-wide watcher used to take whichever window
// spoke last. This drives the real IPC handler with two fake windows.

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => { handlers.set(channel, handler) } },
  webContents: { fromId: () => null },
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
