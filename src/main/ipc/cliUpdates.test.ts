import { beforeEach, expect, it, vi } from 'vitest'

// #1250 row 10: `shell.openPath` RESOLVES with an error string when it cannot
// open a file (a log that is gone gives "Failed to open path"; nothing prunes
// this directory automatically, so that means removed by hand or by another
// tool), and the handler used to discard it, believing the OS would
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

const failed = { kind: 'failed', cli: 'claude', from: '2.1.281', wantedLatest: '2.1.282', installMethod: 'npm', reason: 'command-failed', logPath: '/state/cli-update-logs/claude-1.log', finishedAt: 1 }
const snapshot = { claude: failed as Record<string, unknown>, codex: { kind: 'idle' } as Record<string, unknown> }

beforeEach(() => {
  handlers.clear()
  shell.openPath.mockReset()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  registerCliUpdatesIpc({ on: vi.fn(), getSnapshot: () => snapshot, refresh: vi.fn(), setBehavior: vi.fn(), updateNow: vi.fn() } as never)
})

const openLog = (cli: unknown) => handlers.get('cli-updates:open-log')!({}, cli)

it('opens the log main wrote for that CLI\'s failure, and answers true', async () => {
  shell.openPath.mockResolvedValue('')
  expect(await openLog('claude')).toBe(true)
  expect(shell.openPath).toHaveBeenCalledWith('/state/cli-update-logs/claude-1.log')
})

it('answers false, and warns the diagnostic, when the OS could not open it or openPath throws', async () => {
  const warn = vi.mocked(console.warn)
  shell.openPath.mockResolvedValue('Failed to open path')
  expect(await openLog('claude')).toBe(false)
  expect(warn).toHaveBeenLastCalledWith('[cli-updates] failed to open log:', 'Failed to open path')
  const boom = new Error('boom')
  shell.openPath.mockRejectedValue(boom)
  expect(await openLog('claude')).toBe(false)
  expect(warn).toHaveBeenLastCalledWith('[cli-updates] failed to open log:', boom)
})

// #1423 review a: the renderer used to send a PATH, and any string reached
// shell.openPath, which opens applications too. Nothing but the failed
// state's own log is ever opened now.
it('opens nothing for a path, an unknown CLI, or a CLI whose state is not failed', async () => {
  shell.openPath.mockResolvedValue('')
  expect(await openLog('/Applications/Calculator.app')).toBe(false)
  expect(await openLog('codex')).toBe(false)
  expect(shell.openPath).not.toHaveBeenCalled()
})
