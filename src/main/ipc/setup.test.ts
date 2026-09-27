import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, expect, it, vi } from 'vitest'

// #1403 verification b: every setup answer is saved FIRST, then the IPC runs
// the prerequisite check, which writes its probed tool paths back to the same
// setup.json. When only that second write failed, the IPC rejected and the
// renderer said the answer was not saved, while it was on disk and took
// effect on the next launch.
//
// The REAL handlers, the real setup-state persistence (scratch STATE_DIR) and
// the real prerequisite check. Replaced edges only: Electron's ipcMain (to
// capture the handlers), the login-shell/PATH probes and bundled-archive
// lookups (machine-dependent), the toolchain refresh (process env), and the
// Homebrew installer (not exercised). The write failure is a real rename
// rejection injected into fs/promises, planned per write.

const paths = vi.hoisted(() => ({ STATE_DIR: '' }))
vi.mock('@main/storage/paths.js', () => paths)
const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => Promise<unknown>>())
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => handlers.set(channel, handler) },
}))
vi.mock('@main/setup/binaryResolver.js', () => ({
  resolveToolPath: async () => null,
  isExecutable: async () => false,
  classifyExecutable: async () => 'ok',
}))
vi.mock('@main/setup/runtimeTools.js', () => ({ isBundledArchiveAvailable: async () => false }))
vi.mock('@main/setup/toolchain.js', () => ({ refreshToolchainFromState: async () => {} }))
vi.mock('@main/setup/homebrewInstaller.js', () => ({ installWithHomebrew: vi.fn() }))
// Each rename in order: `true` fails it. The answer's write is the first, the
// check's write-back the second.
const renamePlan = vi.hoisted(() => ({ fail: [] as boolean[] }))
vi.mock('fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      if (renamePlan.fail.shift()) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
      return await actual.rename(from, to)
    },
  }
})

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'setup-ipc-'))
  paths.STATE_DIR = dir
  handlers.clear()
  renamePlan.fail = []
  vi.resetModules()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const { registerSetupIpc } = await import('./setup.js')
  registerSetupIpc()
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args)
const onDisk = async () => JSON.parse(await readFile(join(dir, 'setup.json'), 'utf8')) as Record<string, unknown>

it('answers a saved skip even when the check cannot write its tool paths back', async () => {
  renamePlan.fail = [false, true]
  const check = await invoke('setup:skip-optional', 'mitmdump') as { tools: Record<string, { skipped: boolean }> }
  expect(check.tools.mitmdump!.skipped).toBe(true)
  expect(await onDisk()).toMatchObject({ skippedOptionalTools: { mitmdump: true } })
})

it('answers a saved no-provider acknowledgment even when the check cannot write back', async () => {
  renamePlan.fail = [false, true]
  const check = await invoke('setup:acknowledge-no-providers') as { noProvidersAcknowledged: boolean }
  expect(check.noProvidersAcknowledged).toBe(true)
  expect(await onDisk()).toMatchObject({ acknowledgedNoProviders: true })
})

it('answers a saved manual path even when the check cannot write back', async () => {
  renamePlan.fail = [false, true]
  const result = await invoke('setup:set-tool-path', 'claude', '/opt/bin/claude') as { ok: boolean }
  expect(result.ok).toBe(true)
  expect(await onDisk()).toMatchObject({ manualToolPaths: { claude: '/opt/bin/claude' } })
})

// The rejection path is kept for what it means: the answer itself was not saved.
it('rejects a skip whose own write fails', async () => {
  renamePlan.fail = [true]
  await expect(invoke('setup:skip-optional', 'mitmdump')).rejects.toThrow('ENOSPC')
})
