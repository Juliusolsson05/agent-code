import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { EventEmitter, getEventListeners } from 'node:events'
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
import { holdNextSpawnUntilReady } from './testing/spawnReadiness.js'
import { alive, waitUntil, within } from './testing/processWait.js'

const { spawn: realSpawn } = await vi.importActual<typeof import('node:child_process')>('node:child_process')

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
  // mockReset, not only clearAllMocks: mockClear keeps queued
  // once-implementations. A test that fails after queuing a readiness gate or a
  // process double, but before runOpencode reaches spawn, would otherwise hand
  // that implementation to the next test's first spawn. Vitest 4 resets
  // vi.fn(actual.spawn) back to the real spawn.
  vi.mocked(spawn).mockReset()
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
    // Observed from inside the running child: its stdout already has no name,
    // so a quit or crash mid-export has no plaintext file to leave behind. A
    // cleanup check after settlement cannot see that difference.
    expect(value.outputLinks).toBe(0)
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
    // `ENOENT`, not just `failed`: every runOpencode rejection carries the
    // `OpenCode export failed:` prefix, so a timeout, overflow or parse error
    // would satisfy a weaker assertion without exercising spawn failure.
    await expect(exportOpencodeSession({ ...options(), binary: join(root, 'missing') }, 'ses_fixture')).rejects.toThrow('ENOENT')
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

  it('rejects a spawn that failed before stdio existed without an uncaught child error', async () => {
    // Node's spawn() returns early on EMFILE/ENFILE: no pid, no stderr stream,
    // and `error` then `close` arrive on the next tick. Exhausting descriptors
    // inside a shared test worker would break unrelated tests, so this double
    // reproduces that exact shape instead. EventEmitter throws synchronously
    // from emit('error') when nothing listens; catching it here turns what
    // would be a process-level uncaught exception into an assertable value.
    let uncaught: unknown
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() })
    vi.mocked(spawn).mockImplementationOnce(() => {
      process.nextTick(() => {
        try { child.emit('error', Object.assign(new Error('spawn opencode EMFILE'), { code: 'EMFILE' })) } catch (error) { uncaught = error }
        child.emit('close', -24, null)
      })
      return child as unknown as ReturnType<typeof spawn>
    })
    const controller = new AbortController()
    const failure = await exportOpencodeSession({ ...options(), signal: controller.signal, timeoutMs: 50 }, 'ses_fixture').catch((error: Error) => error)
    expect(uncaught).toBeUndefined()
    expect((failure as Error).message).toContain('EMFILE')
    expect(getEventListeners(controller.signal, 'abort')).toEqual([])
    // Past the 50 ms deadline and two size-guard polls: a timer that survived
    // settlement would try to kill the (never started) child.
    await new Promise(resolve => setTimeout(resolve, 250))
    expect(child.kill).not.toHaveBeenCalled()
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
// Generous, because the readiness gate spends it before the deadline or stop()
// can fire. The bounds asserted below stay as tight as main's originals.
const IMPORT_READY_BUDGET_MS = 10_000

it.each(['stop', 'timeout'] as const)('bounds a hung import on %s and removes its payload', async mode => {
  const { dir, binary, statusFile } = await fixture()
  const spawnPty = vi.fn()
  const prepareLaunch = vi.fn()
  const session = new OpencodeTerminalSession({ cwd: dir, binary, env: { IMPORT_STATUS_FILE: statusFile } }, { spawnPty, prepareLaunch })
  // main's version (e9ac8bdf) waited up to 2 s for this status while the
  // timeout case's 1 s deadline was already running, and on a loaded machine
  // the stop case failed before stop() was ever called. The gate makes the child
  // report before either trigger can fire, and hands the test its ChildProcess
  // at spawn.
  const importChild = holdNextSpawnUntilReady(vi.mocked(spawn), realSpawn, () => existsSync(statusFile), IMPORT_READY_BUDGET_MS)
  // Exists so cleanup can end a child the timeout case never observed. It is not
  // aborted before the outcome is recorded, so that case still proves the deadline.
  const controller = new AbortController()
  let starting: Promise<unknown> | undefined
  try {
    starting = mode === 'stop' ? session.start() : createEmptyOpencodeSession({ cwd: dir, binary, env: { IMPORT_STATUS_FILE: statusFile }, signal: controller.signal, timeoutMs: 1000 })
    // Attach the rejection observer before waiting for startup so a timeout is
    // never reported as an unhandled rejection while the fixture is inspected.
    const outcome = starting.then(() => 'resolved', () => 'rejected')
    await waitUntil(() => importChild.readyAt !== undefined, IMPORT_READY_BUDGET_MS + 5000, 'import child spawn')
    expect(existsSync(statusFile), 'import child ready before its deadline or stop() can fire').toBe(true)
    const status = JSON.parse(readFileSync(statusFile, 'utf8')) as { pid: number; file: string }
    const child = importChild.child!
    expect(status.pid).toBe(child.pid)
    expect(existsSync(status.file)).toBe(true)
    // While the child runs, its import payload still needs a path (`opencode
    // import <path>` reads it by name), but the stdout capture must already be
    // unnamed: nothing an app quit at this moment could leave on disk.
    expect((await readdir(root)).filter(name => name.startsWith('agent-code-opencode-output-'))).toEqual([])
    const stoppedAt = performance.now()
    if (mode === 'stop') await session.stop()
    // Read from the ChildProcess handle, not a raw pid that could be reused once
    // reaped. The fixture ignores SIGTERM, so only SIGKILL ends it in time.
    await waitUntil(() => child.exitCode !== null || child.signalCode !== null, 2000, 'import child exit')
    expect(performance.now() - stoppedAt).toBeLessThan(2000)
    expect(child.signalCode).toBe('SIGKILL')
    expect(await outcome).toBe(mode === 'stop' ? 'resolved' : 'rejected')
    expect(existsSync(dirname(status.file))).toBe(false)
    // Since #845 the import also mints a private stdout capture directory
    // next to the payload, and the timeout and stop kill paths are owned by
    // runOpencode rather than delegated to spawn's built-in options. A
    // leftover agent-code-opencode-* directory here means a kill path skipped
    // cleanup.
    expect((await readdir(root)).filter(name => name.startsWith('agent-code-opencode-'))).toEqual([])
    expect(spawnPty).not.toHaveBeenCalled()
    expect(prepareLaunch).not.toHaveBeenCalled()
  } finally {
    // Abort before awaiting: runOpencode's own terminate() ends a child the test
    // never observed, through `controller` for the direct helper call and
    // through stop() for the session. The handle kill is a no-op once reaped.
    controller.abort()
    await session.stop()
    importChild.child?.kill('SIGKILL')
    await starting?.catch(() => {})
    await rm(dir, { recursive: true, force: true })
  }
}, 30_000)

it('kills a CLI whose stop arrived while its capture was still being prepared', async () => {
  // runOpencode runs synchronously until mkdtemp suspends, so an abort issued
  // right after the call lands after the pre-abort check but before the abort
  // listener exists. `once` listeners are not replayed for past aborts, so only
  // the post-spawn `signal.aborted` replay can stop this child. Without it the
  // SIGTERM-ignoring fixture would live until the 30 s deadline, and stop()
  // during capture setup would silently do nothing.
  const { dir, binary, statusFile } = await fixture()
  const controller = new AbortController()
  const outcome = exportOpencodeSession({ binary, cwd: dir, env: { IMPORT_STATUS_FILE: statusFile }, signal: controller.signal }, 'ses_fixture')
    .then(() => new Error('resolved'), (error: Error) => error)
  controller.abort()
  const spawnedPid = () => vi.mocked(spawn).mock.results[0]?.value?.pid as number | undefined
  try {
    const failure = await within(outcome, 2000)
    expect(failure, 'late stop settles promptly').toBeInstanceOf(Error)
    expect((failure as Error).message).toContain('OpenCode command cancelled')
    // A real child was spawned: this is the replay path, not the "already
    // stopped, create nothing" path the pre-abort check handles.
    expect(spawnedPid()).toBeGreaterThan(0)
    await waitUntil(() => !alive(spawnedPid()!), 2000, 'cancelled child exit')
    expect((await readdir(root)).filter(name => name.startsWith('agent-code-opencode-'))).toEqual([])
  } finally {
    const pid = spawnedPid()
    if (pid && alive(pid)) process.kill(pid, 'SIGKILL')
    await outcome
    await rm(dir, { recursive: true, force: true })
  }
})

// The launcher process-tree termination cases live in
// opencodeCliSessions.processTree.system.test.ts, next to the spawn readiness
// seam they need.
