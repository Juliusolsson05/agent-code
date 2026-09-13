import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, mkdir, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { spawn, type ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// OpenCode's npm launcher is a Node process whose native child inherits stdout
// and stderr (see testing/launcherCli.mjs). A single-process fake cannot show
// that a kill path reaches a descendant, or that settlement stops waiting on
// one, so these cases run a real two-process tree against runOpencode. They
// live apart from opencodeCliSessions.system.test.ts because they own a spawn
// seam (startTree) and a fixture that the output-integrity cases do not need.
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})
import { exportOpencodeSession } from './opencodeCliSessions.js'
import { holdNextSpawnUntilReady } from './testing/spawnReadiness.js'
import { alive, waitUntil, within } from './testing/processWait.js'

const { spawn: realSpawn } = await vi.importActual<typeof import('node:child_process')>('node:child_process')

// Readiness gets a generous budget. The termination bounds stay tight because
// they only start once the tree is ready (see startTree), and the per-test
// timeout covers the readiness budget plus the bounds and cleanup.
const READY_BUDGET_MS = 10_000
const SETTLE_MARGIN_MS = 2_000
const TEST_TIMEOUT_MS = 30_000

type Tree = { pid: number; launcherPid: number }
type Run = {
  statusFile: string
  controller: AbortController
  outcome: Promise<Error>
  launcher: { child?: ChildProcess; readyAt?: number }
}

let root: string
let cwd: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'opencode-tree-test-')))
  cwd = join(root, 'project')
  await mkdir(cwd)
  vi.stubEnv('TMPDIR', root)
  vi.stubEnv('TMP', root)
  vi.stubEnv('TEMP', root)
})
afterEach(async () => {
  // mockReset, not only clearAllMocks: mockClear keeps queued
  // once-implementations. A test that fails after startTree queued its readiness
  // gate, but before runOpencode reached spawn, would otherwise hand that gate
  // to the next test's first spawn. Vitest 4 resets vi.fn(actual.spawn) back to
  // the real spawn.
  vi.mocked(spawn).mockReset()
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})
async function expectClean() { expect(await readdir(root)).toEqual(['project']) }

/**
 * Start one export against a real launcher tree that is ready before any bound arms.
 *
 * runOpencode's spawn() call is held until the descendant reports (see
 * holdNextSpawnUntilReady for why readiness must precede the bounds rather than
 * race them). The test owns the launcher's ChildProcess from spawn.
 */
function startTree(descendant: 'hang' | 'overflow' | 'escaped' | 'escaped-exit', timeoutMs?: number): Run {
  const statusFile = join(cwd, 'descendant.json')
  const launcher = holdNextSpawnUntilReady(vi.mocked(spawn), realSpawn, () => existsSync(statusFile), READY_BUDGET_MS)
  const controller = new AbortController()
  const env = { ...process.env, NODE_OPTIONS: `--import=${new URL('./testing/launcherCli.mjs', import.meta.url).href}`, OPENCODE_LAUNCHER_DESCENDANT: descendant, OPENCODE_LAUNCHER_STATUS: statusFile }
  const outcome = exportOpencodeSession({ binary: process.execPath, cwd, env, signal: controller.signal, ...(timeoutMs === undefined ? {} : { timeoutMs }) }, 'ses_fixture')
    .then(() => new Error('resolved'), (error: Error) => error)
  return { statusFile, controller, outcome, launcher }
}

async function ready(run: Run): Promise<Tree> {
  await waitUntil(() => run.launcher.readyAt !== undefined, READY_BUDGET_MS + 5_000, 'launcher spawn')
  expect(existsSync(run.statusFile), 'fixture tree ready before runOpencode armed its bounds').toBe(true)
  const tree = JSON.parse(readFileSync(run.statusFile, 'utf8')) as Tree
  // The launcher reports its own pid. A descendant's ppid is not evidence: an
  // escaped child whose launcher already exited has been reparented.
  expect(tree.launcherPid).toBe(run.launcher.child?.pid)
  return tree
}

/**
 * Release everything a tree test started, on success and on failure.
 *
 * Abort comes first. When a test fails before it observed the tree (no status,
 * or a failed assertion before its trigger), runOpencode's own terminate() is
 * the only code that can end the group, and without the abort `outcome` would
 * wait for the 30 s default deadline while the tree outlived the test. The
 * launcher is killed through its ChildProcess, which Node makes a no-op once
 * reaped, never through a raw pid that could since have been reused.
 */
async function release(run: Run, tree: Tree | undefined) {
  run.controller.abort()
  run.launcher.child?.kill('SIGKILL')
  if (tree && alive(tree.pid)) process.kill(tree.pid, 'SIGKILL')
  await run.outcome
}

describe('OpenCode CLI process-tree termination', () => {
  it.each([
    { trigger: 'timeout', descendant: 'hang', message: 'timed out after 1000 ms' },
    { trigger: 'stop', descendant: 'hang', message: 'OpenCode command cancelled' },
    { trigger: 'output overflow', descendant: 'overflow', message: 'output exceeds' },
  ] as const)('settles on $trigger and kills a descendant holding stdout and stderr', async ({ trigger, descendant, message }) => {
    const run = startTree(descendant, trigger === 'timeout' ? 1000 : undefined)
    let tree: Tree | undefined
    try {
      tree = await ready(run)
      if (trigger === 'stop') run.controller.abort()
      // Every bound counts from spawn's return, which is also readiness, and
      // sits far below the 30 s default: a broken kill path fails here instead
      // of being rescued by the default deadline.
      const settleBy = run.launcher.readyAt! + (trigger === 'timeout' ? 1000 : 0) + SETTLE_MARGIN_MS
      const failure = await within(run.outcome, settleBy - performance.now())
      expect(failure, `${trigger} settles within its bound`).toBeInstanceOf(Error)
      expect((failure as Error).message).toContain(message)
      await waitUntil(() => !alive(tree!.pid), 2000, 'descendant exit')
      await expectClean()
    } finally {
      await release(run, tree)
    }
  }, TEST_TIMEOUT_MS)

  it('settles a timeout when a descendant left the process group but kept stderr', async () => {
    // A group kill cannot reach a descendant in its own session. Settlement is
    // still bounded because terminate() releases stderr, the pipe `close` would
    // otherwise wait on. The survivor is out of reach by design, so release()
    // kills it rather than the test asserting it dead.
    const run = startTree('escaped', 1000)
    let tree: Tree | undefined
    try {
      tree = await ready(run)
      const failure = await within(run.outcome, run.launcher.readyAt! + 1000 + SETTLE_MARGIN_MS - performance.now())
      expect(failure, 'timeout settles within its bound').toBeInstanceOf(Error)
      expect((failure as Error).message).toContain('timed out after 1000 ms')
      expect(run.launcher.child!.signalCode).toBe('SIGKILL')
      await expectClean()
    } finally {
      await release(run, tree)
    }
  }, TEST_TIMEOUT_MS)

  it('never signals the process group once its leader has been reaped', async () => {
    // The launcher exits 0 at once while an escaped helper keeps stderr open,
    // so the deadline fires after Node reaped the leader but before `close`.
    // Nothing reserves that group id any more: a negative-pid SIGKILL would be
    // aimed at whatever group reused the number. So a regression is recorded,
    // never delivered: the spy swallows every negative-pid request and passes
    // only positive pids (liveness probes, cleanup) to the real kill.
    const realKill = process.kill.bind(process)
    const kills = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => pid < 0 ? true : realKill(pid, signal))
    const run = startTree('escaped-exit', 1000)
    let tree: Tree | undefined
    try {
      tree = await ready(run)
      const launcher = run.launcher.child!
      await waitUntil(() => launcher.exitCode !== null, 2000, 'launcher reaped')
      expect(launcher.exitCode).toBe(0)
      expect(performance.now() - run.launcher.readyAt!, 'leader reaped before the deadline fires').toBeLessThan(1000)
      const failure = await within(run.outcome, run.launcher.readyAt! + 1000 + SETTLE_MARGIN_MS - performance.now())
      expect(failure, 'timeout still settles by releasing stderr').toBeInstanceOf(Error)
      expect((failure as Error).message).toContain('timed out after 1000 ms')
      expect(kills.mock.calls.filter(([pid]) => pid < 0)).toEqual([])
      await expectClean()
    } finally {
      kills.mockRestore()
      await release(run, tree)
    }
  }, TEST_TIMEOUT_MS)

  it('signals the process group only once when stop() follows a timeout before close', async () => {
    // Stop is requested in the microtask right after the deadline's group
    // signal: later than the timeout, earlier than any I/O callback, so always
    // before `close` (which needs the reap). A second group signal there would
    // reuse a number that the first SIGKILL may already have released.
    const run = startTree('hang', 1000)
    const realKill = process.kill.bind(process)
    const kills = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid < 0 && !run.controller.signal.aborted) queueMicrotask(() => run.controller.abort())
      return realKill(pid, signal)
    })
    let tree: Tree | undefined
    try {
      tree = await ready(run)
      const failure = await within(run.outcome, run.launcher.readyAt! + 1000 + SETTLE_MARGIN_MS - performance.now())
      expect(failure, 'timeout then stop settles within its bound').toBeInstanceOf(Error)
      // Cancellation still takes precedence over the timeout it raced.
      expect((failure as Error).message).toContain('OpenCode command cancelled')
      expect(kills.mock.calls.filter(([pid]) => pid < 0)).toEqual([[-tree.launcherPid, 'SIGKILL']])
      await waitUntil(() => !alive(tree!.pid), 2000, 'descendant exit')
      await expectClean()
    } finally {
      kills.mockRestore()
      await release(run, tree)
    }
  }, TEST_TIMEOUT_MS)
})
