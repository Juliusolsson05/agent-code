import { beforeEach, expect, it, vi } from 'vitest'

// #1250 row 10: `shell.openPath` RESOLVES with an error string when it cannot
// open a file (a log removed by the debug-retention prune gives "Failed to
// open path"), and the handler used to discard it, believing the OS would
// show its own dialog. It does not, so View Log did nothing visible. The
// handler now answers whether the log opened.
//
// The REAL handler; Electron's ipcMain is captured and shell.openPath is the
// replaced edge (it is the OS).

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => Promise<unknown>>())
const shell = vi.hoisted(() => ({ openPath: vi.fn<(path: string) => Promise<string>>() }))
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => handlers.set(channel, handler) },
  shell,
}))
vi.mock('@main/window/windowRegistry.js', () => ({ broadcastToWindows: vi.fn() }))
vi.mock('@main/setup/setupState.js', () => ({ setCliUpdateBehavior: vi.fn() }))

import { registerCliUpdatesIpc } from './cliUpdates'

beforeEach(() => {
  handlers.clear()
  shell.openPath.mockReset()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  registerCliUpdatesIpc({ on: vi.fn(), getSnapshot: vi.fn(), refresh: vi.fn(), setBehavior: vi.fn(), updateNow: vi.fn() } as never)
})

const openLog = (path: string) => handlers.get('cli-updates:open-log')!({}, path)

it('answers true when the log opened', async () => {
  shell.openPath.mockResolvedValue('')
  expect(await openLog('/logs/claude-update.log')).toBe(true)
})

it('answers false when the OS could not open it, and when openPath throws', async () => {
  shell.openPath.mockResolvedValue('Failed to open path')
  expect(await openLog('/logs/pruned.log')).toBe(false)
  shell.openPath.mockRejectedValue(new Error('boom'))
  expect(await openLog('/logs/pruned.log')).toBe(false)
})
