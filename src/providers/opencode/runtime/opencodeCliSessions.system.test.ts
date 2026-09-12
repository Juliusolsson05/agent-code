import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { performance } from 'node:perf_hooks'
import { spawn } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// This file was created independently on two branches: output integrity for
// large exports (#845) and cancel/timeout bounds for the empty-session import
// (e9ac8bdf, Refs #864). Both suites spawn real children against the same
// runOpencode boundary, so they share one file. They also share the TMPDIR
// isolation below, which lets the cancel/timeout cases check that the new
// stdout capture directory is removed as well as the import payload.
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})
vi.mock('node-pty', () => ({ spawn: vi.fn() }))
import {
  createEmptyOpencodeSession,
  exportOpencodeSession,
  importOpencodeSession,
  listOpencodeModels,
  readResolvedOpencodeConfig,
} from './opencodeCliSessions.js'
import { OpencodeTerminalSession } from './opencodeTerminalSession.js'

let root: string
let cwd: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'opencode-export-test-')))
  cwd = join(root, 'project with spaces')
  await mkdir(cwd)
  vi.stubEnv('TMPDIR', root)
  vi.stubEnv('TMP', root)
  vi.stubEnv('TEMP', root)
})
afterEach(async () => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})
function options(mode = '') {
  return {
    binary: process.execPath, cwd,
    env: { ...process.env, NODE_OPTIONS: `--import=${new URL('./testing/abruptCli.mjs', import.meta.url).href}`, OPENCODE_FIXTURE_MODE: mode, OPENCODE_FIXTURE_VALUE: 'environment forwarded' },
  }
}
async function expectClean() { expect(await readdir(root)).toEqual(['project with spaces']) }

describe('OpenCode CLI output integrity', () => {
  it('captures a complete large export from a process that exits immediately after writing stdout', async () => {
    const id = 'ses_fixture;not-a-shell-command'
    const value = await exportOpencodeSession(options(), id)
    expect(value.info).toEqual({ id, directory: cwd })
    expect((value.messages as { parts: { text: string }[] }[])[0].parts[0].text).toHaveLength('fixture text '.length * 160000)
    expect(value.fixtureEnv).toBe('environment forwarded')
    expect(value.outputMode).toBe(0o600)
    await expectClean()
  })

  it('also preserves large resolved-config output used when OpenCode is the switch target', async () => {
    const config = await readResolvedOpencodeConfig(options())
    expect(config.model).toBe('fixture/model')
    expect(config.fixture).toHaveLength('fixture text '.length * 160000)
    await expectClean()
  })

  it('preserves native import and removes both import and capture files', async () => {
    await expect(importOpencodeSession(options(), { info: { id: 'ses_import' }, messages: [] })).resolves.toBe('ses_import')
    await expectClean()
  })

  it('rejects failed native commands rather than parsing their stdout, and cleans up', async () => {
    await expect(exportOpencodeSession(options('failure'), 'ses_fixture')).rejects.toThrow('fixture command refused')
    await expectClean()
  })

  it('rejects genuinely invalid JSON without including transcript text in the error', async () => {
    const failure = await exportOpencodeSession(options('invalid'), 'ses_fixture').catch((error: Error) => error)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain('did not return valid JSON')
    expect((failure as Error).message).not.toContain('PRIVATE')
    await expectClean()
  })

  it('rejects oversized file output before allocating it for JSON parsing', async () => {
    await expect(exportOpencodeSession(options('oversized'), 'ses_fixture')).rejects.toThrow('output exceeds')
    await expectClean()
  })

  it('cleans up when the CLI cannot be spawned', async () => {
    await expect(exportOpencodeSession({ ...options(), binary: join(root, 'missing') }, 'ses_fixture')).rejects.toThrow('failed')
    await expectClean()
  })

  it('terminates over-limit capture while the child is still running', async () => {
    await expect(exportOpencodeSession(options('oversized-running'), 'ses_fixture')).rejects.toThrow('output exceeds')
    await expectClean()
  })

  it('drains large stderr but retains only a bounded diagnostic prefix', async () => {
    const error = await exportOpencodeSession(options('stderr-overflow'), 'ses_fixture').catch((error: Error) => error)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('[stderr truncated]')
    expect(Buffer.byteLength((error as Error).message)).toBeLessThan(64 * 1024 + 100)
    await expectClean()
  })

  it('preserves line-oriented model discovery through the same capture boundary', async () => {
    await expect(listOpencodeModels(options())).resolves.toEqual(['fixture/model-a', 'fixture/model-b'])
    await expectClean()
  })

  it('retains capture ownership after a post-spawn error until process close', async () => {
    // Only this otherwise hard-to-provoke lifecycle failure uses a process
    // double. The truncation/config/overflow cases above spawn real children.
    const child = Object.assign(new EventEmitter(), { stderr: new PassThrough(), kill: vi.fn() })
    vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>)
    const result = exportOpencodeSession(options(), 'ses_fixture').catch((error: Error) => error)
    let timer: ReturnType<typeof setTimeout> | undefined
    let beforeClose: string | undefined
    try {
      await vi.waitFor(() => expect(vi.mocked(spawn).mock.calls.length).toBe(1))
      child.emit('spawn')
      child.emit('error', new Error('controlled post-spawn error'))
      beforeClose = await Promise.race([
        result.then(() => 'settled before close'),
        new Promise<string>(resolve => { timer = setTimeout(() => resolve('waiting for close'), 200) }),
      ])
    } finally {
      clearTimeout(timer)
      child.stderr.end()
      child.emit('close', 1, null)
      await result
    }
    expect(beforeClose).toBe('waiting for close')
    expect((await result as Error).message).toContain('controlled post-spawn error')
    await expectClean()
  })
})

// A real child process is necessary: a promise mock cannot establish that
// cancellation kills the import process or releases its private export file.
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'oc-import-cancel-'))
  const binary = join(dir, 'fake-cli')
  const statusFile = join(dir, 'status.json')
  try {
    await writeFile(binary, `#!${process.execPath}\nconst fs = require('node:fs');\nfs.writeFileSync(process.env.IMPORT_STATUS_FILE + '.tmp', JSON.stringify({ pid: process.pid, file: process.argv[3] }));\nfs.renameSync(process.env.IMPORT_STATUS_FILE + '.tmp', process.env.IMPORT_STATUS_FILE);\nprocess.on('SIGTERM', () => {});\nsetInterval(() => {}, 1000);\n`, { mode: 0o700 })
    return { dir, binary, statusFile }
  } catch (error) { await rm(dir, { recursive: true, force: true }); throw error }
}
function alive(pid: number) {
  try { process.kill(pid, 0); return true } catch { return false }
}

it.each(['stop', 'timeout'] as const)('bounds a hung import on %s and removes its payload', async mode => {
  const { dir, binary, statusFile } = await fixture()
  const spawnPty = vi.fn()
  const prepareLaunch = vi.fn()
  const session = new OpencodeTerminalSession({ cwd: dir, binary, env: { IMPORT_STATUS_FILE: statusFile } }, { spawnPty, prepareLaunch })
  let status: { pid: number; file: string } | undefined
  let starting: Promise<unknown> | undefined
  try {
    starting = mode === 'stop' ? session.start() : createEmptyOpencodeSession({ cwd: dir, binary, env: { IMPORT_STATUS_FILE: statusFile }, timeoutMs: 1000 })
    // Attach the rejection observer before waiting for startup so a timeout is
    // never reported as an unhandled rejection while the fixture is inspected.
    const outcome = starting.then(() => 'resolved', () => 'rejected')
    await waitUntil(() => existsSync(statusFile), 2000, 'import child status')
    status = JSON.parse(readFileSync(statusFile, 'utf8'))
    expect(existsSync(status!.file)).toBe(true)
    const stoppedAt = performance.now()
    if (mode === 'stop') await session.stop()
    await waitUntil(() => !alive(status!.pid), 2000, 'import child exit')
    expect(performance.now() - stoppedAt).toBeLessThan(2000)
    expect(await outcome).toBe(mode === 'stop' ? 'resolved' : 'rejected')
    expect(existsSync(dirname(status!.file))).toBe(false)
    // Since #845 the import also mints a private stdout capture directory
    // next to the payload. spawn has no built-in timeout or SIGKILL abort, so
    // those kill paths are hand-written in runOpencode. A leftover
    // agent-code-opencode-* directory here means a kill path skipped cleanup.
    expect((await readdir(root)).filter(name => name.startsWith('agent-code-opencode-'))).toEqual([])
    expect(spawnPty).not.toHaveBeenCalled()
    expect(prepareLaunch).not.toHaveBeenCalled()
  } finally {
    if (status && alive(status.pid)) process.kill(status.pid, 'SIGKILL')
    await session.stop()
    await starting?.catch(() => {})
    await rm(dir, { recursive: true, force: true })
  }
})

async function waitUntil(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setImmediate(resolve))
  }
}
