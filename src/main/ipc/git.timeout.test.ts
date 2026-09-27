import { beforeEach, describe, expect, it, vi } from 'vitest'

// #1250 row 11: every git failure returns '' by contract, so a command that
// hit the runner's 5 s timeout read as "no output": a dirty worktree as CLEAN,
// a branch with unmerged patches as patch-equivalent (a cleanup suggestion), a
// slow repo as "not a git repository", and a partial GitBar status as clean.
//
// The REAL handlers and runner. `execFile` is the replaced edge: it answers
// like git for a two-worktree repo, and fails the chosen commands exactly as
// Node's execFile does on its `timeout` (killed: true, signal: 'SIGTERM').

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => Promise<unknown>>())
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => handlers.set(channel, handler) },
}))
vi.mock('@main/setup/toolchain.js', () => ({ getToolPath: () => 'git' }))

type Answer = string | 'TIMEOUT' | 'EXIT128' | 'HOLD'
// Held commands, released by the test: they occupy the runner's process slots.
const held = vi.hoisted(() => ({ release: [] as Array<() => void> }))
const git = vi.hoisted(() => ({ answer: (_cwd: string, _args: string[]): string => '', calls: [] as string[][] }))
vi.mock('child_process', () => ({
  execFile: (_file: string, args: string[], options: { cwd: string }, callback: (error: unknown, value?: { stdout: string; stderr: string }) => void) => {
    git.calls.push(args)
    const answer = git.answer(options.cwd, args) as Answer
    if (answer === 'TIMEOUT') {
      setTimeout(() => callback(Object.assign(new Error('Command failed: git (timed out)'), { killed: true, signal: 'SIGTERM', code: null })), 0)
    } else if (answer === 'HOLD') {
      held.release.push(() => callback(null, { stdout: 'main\n', stderr: '' }))
    } else if (answer === 'EXIT128') {
      // An ordinary git failure, as Node reports it: a non-zero exit, not killed.
      setTimeout(() => callback(Object.assign(new Error('fatal: not a git repository'), { killed: false, signal: null, code: 128 })), 0)
    } else {
      setTimeout(() => callback(null, { stdout: answer, stderr: '' }), 0)
    }
  },
}))

const PORCELAIN = [
  'worktree /repo', 'HEAD 1111111111111111111111111111111111111111', 'branch refs/heads/main', '',
  'worktree /repo-feat', 'HEAD 2222222222222222222222222222222222222222', 'branch refs/heads/feat', '',
].join('\n')

function repo(overrides: (cwd: string, args: string[]) => Answer | undefined) {
  git.calls = []
  git.answer = (cwd, args) => {
    const override = overrides(cwd, args)
    if (override !== undefined) return override
    const command = args.join(' ')
    if (command.startsWith('worktree list')) return PORCELAIN
    if (command.startsWith('rev-list')) return '0\t3\n'
    if (command.startsWith('cherry')) return '+ aaaa\n'
    if (command.startsWith('log -1')) return '1790000000\u00002 hours ago\n'
    if (command.startsWith('rev-parse --abbrev-ref')) return 'feat\n'
    return ''
  }
}

let register: () => void
beforeEach(async () => {
  handlers.clear()
  vi.resetModules()
  register = (await import('./git')).registerGitIpc
  register()
})

const invoke = (channel: string, cwd: string) => handlers.get(channel)!({}, cwd) as Promise<Record<string, unknown>>
const row = (result: Record<string, unknown>, path: string) =>
  (result.worktrees as Array<Record<string, unknown>>).find(worktree => worktree.path === path)!

describe('a git timeout in the Worktrees panel', () => {
  it('never reads a timed-out git status as clean', async () => {
    repo((cwd, args) => (cwd === '/repo-feat' && args[0] === 'status' ? 'TIMEOUT' : undefined))
    const result = await invoke('git:worktree-status', '/repo')
    expect(row(result, '/repo-feat')).toMatchObject({ dirty: true, statusTimedOut: true, category: 'review' })
    // The other row is untouched by this row's timeout.
    expect(row(result, '/repo').statusTimedOut).toBeUndefined()
  })

  it('never offers a branch as patch-equivalent when git cherry timed out', async () => {
    repo((_cwd, args) => (args[0] === 'cherry' ? 'TIMEOUT' : undefined))
    const result = await invoke('git:worktree-status', '/repo')
    expect(row(result, '/repo-feat')).toMatchObject({ statusTimedOut: true, category: 'review' })
  })

  it('does not cache a result with a timed-out row', async () => {
    repo((cwd, args) => (cwd === '/repo-feat' && args[0] === 'status' ? 'TIMEOUT' : undefined))
    await invoke('git:worktree-status', '/repo')
    repo(() => undefined)
    const second = await invoke('git:worktree-status', '/repo')
    expect(row(second, '/repo-feat').statusTimedOut).toBeUndefined()
    expect(row(second, '/repo-feat').category).toBe('active-unmerged')
  })

  it('says a timed-out list is a timeout, not "not a repository", and does not cache it', async () => {
    repo((_cwd, args) => (args[0] === 'worktree' ? 'TIMEOUT' : undefined))
    expect(await invoke('git:worktrees', '/slow')).toEqual({ ok: false, gitMissing: false, timedOut: true })
    expect(await invoke('git:worktree-status', '/slow')).toEqual({ ok: false, gitMissing: false, timedOut: true })
    repo(() => undefined)
    expect(await invoke('git:worktrees', '/slow')).toMatchObject({ ok: true })
  })
})

// #1429 review c: the timeout must be told apart from OTHER failures, or
// every non-repository would read "git took too long", forever.
describe('an ordinary git failure is not a timeout', () => {
  it('keeps "not a repository" for a plain non-repository', async () => {
    repo((_cwd, args) => (args[0] === 'rev-parse' || args[0] === 'worktree' ? 'EXIT128' : undefined))
    expect(await invoke('git:status', '/plain')).toEqual({ ok: false, gitMissing: false, timedOut: false })
    expect(await invoke('git:worktrees', '/plain')).toEqual({ ok: false, gitMissing: false, timedOut: false })
  })

  it('keeps a main row as main when its status timed out', async () => {
    repo((cwd, args) => (cwd === '/repo' && args[0] === 'status' ? 'TIMEOUT' : undefined))
    const result = await invoke('git:worktree-status', '/repo')
    expect(row(result, '/repo')).toMatchObject({ statusTimedOut: true, category: 'main' })
  })
})

// #1429 verification a: the trace is captured when a command is QUEUED, not
// when the runner drains it. A request that waits behind eight busy git
// processes runs its command from another request's drain, outside its own
// async context; reading the store at drain time would lose its timeout.
describe('a queued request keeps its own timeout', () => {
  it('reports the timeout of a request that waited behind eight busy commands', async () => {
    repo((cwd, args) => (args[0] === 'rev-parse' && cwd.startsWith('/busy') ? 'HOLD' : cwd === '/slow' && args[0] === 'rev-parse' ? 'TIMEOUT' : undefined))
    held.release = []
    const busy = Array.from({ length: 8 }, (_, i) => invoke('git:status', `/busy-${i}`))
    await vi.waitFor(() => expect(held.release).toHaveLength(8))
    const queued = invoke('git:status', '/slow')
    // Free one slot at a time; the queued request's command runs from a drain.
    for (const release of held.release.splice(0)) release()
    expect(await queued).toEqual({ ok: false, gitMissing: false, timedOut: true })
    // The eight busy requests finish normally and report no timeout.
    for (const result of await Promise.all(busy)) expect(result.incomplete).toBeUndefined()
  })
})

describe('a git timeout in GitBar', () => {
  it('says a timed-out branch probe is a timeout', async () => {
    repo((_cwd, args) => (args[0] === 'rev-parse' ? 'TIMEOUT' : undefined))
    expect(await invoke('git:status', '/repo-feat')).toEqual({ ok: false, gitMissing: false, timedOut: true })
  })

  it('marks a status whose log timed out as incomplete, and a full one as not', async () => {
    repo((_cwd, args) => (args[0] === 'log' ? 'TIMEOUT' : undefined))
    expect(await invoke('git:status', '/repo-feat')).toMatchObject({ ok: true, incomplete: true })
    repo(() => undefined)
    expect((await invoke('git:status', '/repo-feat')).incomplete).toBeUndefined()
  })
})
