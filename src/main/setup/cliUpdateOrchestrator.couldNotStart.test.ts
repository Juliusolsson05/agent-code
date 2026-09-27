import { describe, expect, it, vi } from 'vitest'

// #1425 (found by #1423's review b): runUpdate published `updating`, then
// awaited openLog's mkdir outside any catch. A read-only or full state dir
// rejected there and the snapshot stayed `updating` — an undismissable
// "Updating…" row forever, and a dropped IPC rejection for Update Now.
//
// The fs boundary is where the failure really happens, so that is the one
// thing replaced: mkdir of the log folder rejects the way macOS does for a
// folder the user cannot write (EACCES). The update command runner is a spy
// that must never be reached — an update without a log is not attempted.
const fsState = vi.hoisted(() => ({ mkdirError: null as NodeJS.ErrnoException | null, writeError: null as NodeJS.ErrnoException | null }))
vi.mock('fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return {
    ...actual,
    mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
      if (fsState.mkdirError) throw fsState.mkdirError
      return actual.mkdir(...args)
    },
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      if (fsState.writeError) throw fsState.writeError
      return actual.writeFile(...args)
    },
  }
})
const runShellCommand = vi.hoisted(() => vi.fn(async () => ({ stdout: '', stderr: '' })))
vi.mock('@main/setup/shell.js', () => ({ runShellCommand }))
vi.mock('@main/setup/toolchain.js', () => ({ getToolPath: (cli: string) => `/usr/local/bin/${cli}` }))
vi.mock('@main/setup/cliVersion.js', async importOriginal => ({
  ...(await importOriginal<typeof import('@main/setup/cliVersion.js')>()),
  readInstalledVersion: async () => ({ ok: true, version: '2.1.281' }),
}))
vi.mock('@main/setup/setupState.js', () => ({
  loadSetupState: async () => ({ cliUpdateCache: { claude: { latestVersion: '2.1.282' }, codex: { latestVersion: '2.1.282' } } }),
  updateCliUpdateCache: async () => undefined,
}))
vi.mock('@main/setup/cliInstallMethod.js', () => ({ detectCliInstallMethod: async () => 'npm' }))

import { CliUpdateOrchestrator } from './cliUpdateOrchestrator.js'

describe('an update that cannot start (#1425)', () => {
  it('fails as could-not-start with no log, instead of staying Updating', async () => {
    fsState.mkdirError = Object.assign(new Error("EACCES: permission denied, mkdir '/state/cli-update-logs'"), { code: 'EACCES' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const orchestrator = new CliUpdateOrchestrator({ list: () => [], getSessionKind: () => 'claude' } as never, { acquireUpdateLease: () => () => undefined })
      const kinds: string[] = []
      orchestrator.on('state', snapshot => { kinds.push(snapshot.claude.kind) })

      const snapshot = await orchestrator.updateOnce('claude')

      expect(snapshot.claude).toMatchObject({
        kind: 'failed', reason: 'could-not-start', logPath: null, from: '2.1.281', wantedLatest: '2.1.282', installMethod: 'npm',
      })
      // It did announce the attempt, and it did not stop there.
      expect(kinds).toEqual(['updating', 'failed'])
      expect(runShellCommand).not.toHaveBeenCalled()
      // The OS text stays in main's log (q22), never in the state.
      expect(JSON.stringify(snapshot.claude)).not.toContain('EACCES')
      expect(warn).toHaveBeenCalled()
    } finally {
      fsState.mkdirError = null
      warn.mockRestore()
    }
  })
})

// #1447 review a: the folder was the only thing checked. A folder that already
// exists but will not take a new file (EACCES on the folder, ENOSPC) let the
// update run with no log, and View Log then pointed at a file that never was.
describe('an update whose log file cannot be created (#1447 review a)', () => {
  it('fails as could-not-start and never runs the command', async () => {
    fsState.writeError = Object.assign(new Error("ENOSPC: no space left on device, open '/state/cli-update-logs/claude-x.log'"), { code: 'ENOSPC' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    runShellCommand.mockClear()
    try {
      const orchestrator = new CliUpdateOrchestrator({ list: () => [], getSessionKind: () => 'claude' } as never, { acquireUpdateLease: () => () => undefined })
      const snapshot = await orchestrator.updateOnce('claude')
      expect(snapshot.claude).toMatchObject({ kind: 'failed', reason: 'could-not-start', logPath: null })
      expect(runShellCommand).not.toHaveBeenCalled()
    } finally {
      fsState.writeError = null
      warn.mockRestore()
    }
  })
})

// #1447 review a: publishing a state is synchronous (emit -> the IPC broadcast
// -> webContents.send). A listener that throws on `updating` (a window torn
// down mid-send) aborted runUpdate before any later state, leaving the
// snapshot `updating` for good. Publication failures must not steer the
// update's own state machine.
describe('a state listener that throws (#1447 review a)', () => {
  it('does not strand updating', async () => {
    fsState.mkdirError = Object.assign(new Error('EACCES'), { code: 'EACCES' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const orchestrator = new CliUpdateOrchestrator({ list: () => [], getSessionKind: () => 'claude' } as never, { acquireUpdateLease: () => () => undefined })
      orchestrator.on('state', snapshot => { if (snapshot.claude.kind === 'updating') throw new Error('Object has been destroyed') })
      const snapshot = await orchestrator.updateOnce('claude')
      expect(snapshot.claude.kind).toBe('failed')
      expect(orchestrator.getSnapshot().claude.kind).not.toBe('updating')
    } finally {
      fsState.mkdirError = null
      warn.mockRestore()
    }
  })
})
