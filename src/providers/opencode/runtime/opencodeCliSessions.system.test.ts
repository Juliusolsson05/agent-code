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
    // While the child runs, its import payload still needs a path (`opencode
    // import <path>` reads it by name), but the stdout capture must already be
    // unnamed: nothing an app quit at this moment could leave on disk.
    expect((await readdir(root)).filter(name => name.startsWith('agent-code-opencode-output-'))).toEqual([])
    const stoppedAt = performance.now()
    if (mode === 'stop') await session.stop()
    await waitUntil(() => !alive(status!.pid), 2000, 'import child exit')
    expect(performance.now() - stoppedAt).toBeLessThan(2000)
    expect(await outcome).toBe(mode === 'stop' ? 'resolved' : 'rejected')
    expect(existsSync(dirname(status!.file))).toBe(false)
    // Since #845 the import also mints a private stdout capture directory
    // next to the payload, and the timeout and stop kill paths are owned by
    // runOpencode rather than delegated to spawn's built-in options. A
    // leftover agent-code-opencode-* directory here means a kill path skipped
    // cleanup.
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

// OpenCode's npm launcher is a Node process whose native child inherits stdout
// and stderr (see testing/launcherCli.mjs). A single-process fake cannot show
// that a kill path reaches a descendant, or that settlement stops waiting on
// one, so these cases run a real two-process tree. Each bound is far below the
// 30 s default deadline: a broken kill path fails here, it is not rescued.
describe('OpenCode CLI process-tree termination', () => {
  type Tree = { pid: number; launcherPid: number }
  function launcher(descendant: 'hang' | 'overflow' | 'escaped', extra: { signal?: AbortSignal; timeoutMs?: number }) {
    const statusFile = join(cwd, 'descendant.json')
    const env = { ...process.env, NODE_OPTIONS: `--import=${new URL('./testing/launcherCli.mjs', import.meta.url).href}`, OPENCODE_LAUNCHER_DESCENDANT: descendant, OPENCODE_LAUNCHER_STATUS: statusFile }
    return { statusFile, options: { binary: process.execPath, cwd, env, ...extra } }
  }
  async function killTree(tree: Tree | undefined) {
    for (const pid of [tree?.pid, tree?.launcherPid]) if (pid && alive(pid)) process.kill(pid, 'SIGKILL')
  }

  it.each([
    { trigger: 'timeout', descendant: 'hang', message: 'timed out after 2000 ms' },
    { trigger: 'stop', descendant: 'hang', message: 'OpenCode command cancelled' },
    { trigger: 'output overflow', descendant: 'overflow', message: 'output exceeds' },
  ] as const)('settles on $trigger and kills a descendant holding stdout and stderr', async ({ trigger, descendant, message }) => {
    const controller = new AbortController()
    const run = launcher(descendant, { signal: controller.signal, ...(trigger === 'timeout' ? { timeoutMs: 2000 } : {}) })
    const startedAt = performance.now()
    const outcome = exportOpencodeSession(run.options, 'ses_fixture').then(() => new Error('resolved'), (error: Error) => error)
    let tree: Tree | undefined
    try {
      await waitUntil(() => existsSync(run.statusFile), 5000, 'descendant status')
      tree = JSON.parse(readFileSync(run.statusFile, 'utf8')) as Tree
      if (trigger === 'stop') controller.abort()
      const settleBy = (trigger === 'timeout' ? startedAt + 2000 : performance.now()) + 2000
      const failure = await within(outcome, settleBy - performance.now())
      expect(failure, `${trigger} settles within its bound`).toBeInstanceOf(Error)
      expect((failure as Error).message).toContain(message)
      await waitUntil(() => !alive(tree!.pid), 2000, 'descendant exit')
      await expectClean()
    } finally {
      await killTree(tree)
      await outcome
    }
  })

  it('settles a timeout when a descendant left the process group but kept stderr', async () => {
    // A group kill cannot reach a descendant in its own session. Settlement is
    // still bounded because terminate() releases stderr, the pipe `close` would
    // otherwise wait on. The survivor is out of reach by design, so it is
    // killed in finally rather than asserted dead.
    const run = launcher('escaped', { timeoutMs: 2000 })
    const startedAt = performance.now()
    const outcome = exportOpencodeSession(run.options, 'ses_fixture').then(() => new Error('resolved'), (error: Error) => error)
    let tree: Tree | undefined
    try {
      await waitUntil(() => existsSync(run.statusFile), 5000, 'descendant status')
      tree = JSON.parse(readFileSync(run.statusFile, 'utf8')) as Tree
      const failure = await within(outcome, startedAt + 4000 - performance.now())
      expect(failure, 'timeout settles within its bound').toBeInstanceOf(Error)
      expect((failure as Error).message).toContain('timed out after 2000 ms')
      await waitUntil(() => !alive(tree!.launcherPid), 2000, 'launcher exit')
      await expectClean()
    } finally {
      await killTree(tree)
      await outcome
    }
  })
})

async function within<T>(promise: Promise<T>, ms: number): Promise<T | 'pending'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<'pending'>(resolve => { timer = setTimeout(() => resolve('pending'), Math.max(0, ms)) })])
  } finally {
    clearTimeout(timer)
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setImmediate(resolve))
  }
}
