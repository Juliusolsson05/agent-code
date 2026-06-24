import { ipcMain } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { join } from 'path'
import { stat } from 'fs/promises'
import type { GitWorktreeStatus, WorktreeIdentity } from '@shared/types/git'
import { getToolPath } from '@main/setup/toolchain.js'
// GitBar IPC contract + numstat parser are shared so preload/renderer can't
// drift from this producer. See @shared/types/gitStatus and @shared/git/numstat.
import type {
  GitNumstatLine,
  GitRecentCommit,
  GitSubmoduleStatus,
  GitBarStatusResult,
} from '@shared/types/gitStatus.js'
import { parseNumstat } from '@shared/git/numstat.js'

// Git status IPC — powers GitBar.
//
// Runs git commands in a given cwd and returns structured data. All
// commands are read-only; errors return { ok: false } so the UI
// degrades gracefully for non-git directories.
//
// Submodule handling: parent `git diff HEAD --numstat` shows a
// modified submodule path as a +1/-1 gitlink line (SHA pointer
// change, not real diff). To be useful when working across
// submodules we walk into each one and compute:
//   - bumped: parent-registered SHA differs from submodule HEAD
//       diff range = registered..HEAD
//   - dirty: uncommitted edits inside the submodule
//       diff = HEAD (worktree)
//   - both: parent bumped AND submodule has extra dirty edits
//       diff = registered (spans both the committed range and the
//       dirty on-top)
// A clean submodule is skipped entirely so repos with untouched
// submodules don't add noise to the bar.

const exec = promisify(execFile)

// Local aliases over the shared GitBar contract types — keeps the many internal
// uses unchanged while the canonical shapes live in @shared/types/gitStatus.
type NumstatLine = GitNumstatLine
const WORKTREE_CACHE_TTL_MS = 30_000
const WORKTREE_STATUS_CONCURRENCY = 6
const GIT_PROCESS_CONCURRENCY = 8

type CacheEntry<T> = {
  expiresAt: number
  settled: boolean
  promise: Promise<T>
}

type QueuedGitCommand = {
  cwd: string
  args: string[]
  resolve: (stdout: string) => void
  reject: (err: unknown) => void
}

const worktreeListCache = new Map<string, CacheEntry<WorktreeIdentity[]>>()
const worktreeStatusCache = new Map<string, CacheEntry<GitWorktreeStatus[]>>()
const gitQueue: QueuedGitCommand[] = []
let activeGitProcesses = 0

function seedCacheAliases<T>(
  cache: Map<string, CacheEntry<T>>,
  keys: string[],
  entry: CacheEntry<T>,
): void {
  for (const key of keys) {
    cache.set(key, entry)
  }
}

// Centralized git runner. Returns stdout; swallows errors and returns
// '' so callers can treat "no output" as a valid signal (clean
// worktree, missing HEAD, missing submodule checkout). Failing loudly
// here would cascade a single bad command into an overall
// { ok: false }, losing the rest of the data we CAN compute.
async function git(cwd: string, args: string[]): Promise<string> {
  return await new Promise<string>(resolve => {
    gitQueue.push({
      cwd,
      args,
      resolve,
      reject: () => resolve(''),
    })
    drainGitQueue()
  })
}

function drainGitQueue(): void {
  while (activeGitProcesses < GIT_PROCESS_CONCURRENCY && gitQueue.length > 0) {
    const next = gitQueue.shift()!
    activeGitProcesses += 1
    void runGitCommand(next.cwd, next.args)
      .then(next.resolve, next.reject)
      .finally(() => {
        activeGitProcesses -= 1
        drainGitQueue()
      })
  }
}

async function runGitCommand(cwd: string, args: string[]): Promise<string> {
  try {
    // WHY every git command shares one process-wide limiter:
    // per-feature limits are not enough when WorktreesBar, GitBar, history
    // loading, and live work-context refreshes all wake at the same time. A
    // 110-worktree repo can otherwise schedule hundreds of read-only git
    // subprocesses in overlapping waves. Node's child_process APIs are
    // asynchronous, but the OS, disk, and main-process IPC still pay for every
    // active child. Central backpressure makes git data lag under load instead
    // of letting housekeeping work starve orchestration coordination.
    const { stdout } = await exec(getToolPath('git', 'git'), args, { cwd, timeout: 5000 })
    return stdout
  } catch {
    return ''
  }
}

function parseRevListCounts(out: string): { behind: number; ahead: number } | null {
  const match = /^(\d+)\s+(\d+)$/.exec(out.trim())
  if (!match) return null
  return {
    behind: Number(match[1]),
    ahead: Number(match[2]),
  }
}

function parsePatchUniqueAhead(out: string): number {
  return out
    .split('\n')
    .filter(line => line.startsWith('+ '))
    .length
}

function parseWorktreePorcelain(out: string): WorktreeIdentity[] {
  const worktrees: WorktreeIdentity[] = []
  let current: WorktreeIdentity | null = null

  for (const line of out.split('\n')) {
    if (!line.trim()) {
      if (current) worktrees.push(current)
      current = null
      continue
    }
    const [key, ...rest] = line.split(' ')
    const value = rest.join(' ')
    if (key === 'worktree') {
      if (current) worktrees.push(current)
      current = { path: value, branch: null, head: null, detached: false }
    } else if (current && key === 'HEAD') {
      current.head = value || null
    } else if (current && key === 'branch') {
      current.branch = value.replace(/^refs\/heads\//, '') || null
    } else if (current && key === 'detached') {
      current.detached = true
    }
  }
  if (current) worktrees.push(current)
  return worktrees
}

export async function listWorktreesForCwd(cwd: string): Promise<WorktreeIdentity[]> {
  const now = Date.now()
  const cached = worktreeListCache.get(cwd)
  if (cached && (!cached.settled || cached.expiresAt > now)) return cloneWorktrees(await cached.promise)

  // Worktree identity is stable on human timescales but several hot paths
  // ask for it back-to-back: WorktreesBar status, WorktreeActivity summary,
  // initial history, older history, and live session context refreshes. A
  // tiny main-process cache removes duplicate `git worktree list` spawns
  // across those independently-owned surfaces without hiding successful
  // results for more than a short post-probe window.
  let cacheableResult = false
  const entry: CacheEntry<WorktreeIdentity[]> = {
    expiresAt: 0,
    settled: false,
    promise: Promise.resolve([]),
  }
  entry.promise = git(cwd, ['worktree', 'list', '--porcelain'])
    .then(out => {
      const worktrees = out.trim() ? parseWorktreePorcelain(out) : []
      cacheableResult = worktrees.length > 0
      if (cacheableResult) {
        // WHY alias every returned worktree path to the same probe: during
        // multi-agent orchestration, siblings often ask from different checkout
        // roots of the same repo. `git worktree list` returns the same answer
        // for all of them, so exact-cwd cache keys turn one logical query into N
        // subprocesses right when the app is already busy creating/checking
        // worktrees. Aliasing after the first successful probe keeps failures
        // retryable while sharing good data across sibling roots.
        seedCacheAliases(worktreeListCache, [
          cwd,
          ...worktrees.map(worktree => worktree.path),
        ], entry)
      }
      return worktrees
    })
    .catch(() => [])
    .finally(() => {
      // WHY the TTL starts after the probe settles, not before it starts:
      // this cache exists to coalesce independently-owned UI refresh paths.
      // A slow `git worktree list` can exceed the five-second freshness
      // window on large repos or busy disks; if we expire pending promises by
      // start time, the second caller launches another identical subprocess
      // while the first is still running. Pending probes are always fresh
      // enough because no newer result exists yet, then the normal short TTL
      // begins once we actually have data to reuse. Empty results are not
      // cached after settle because this code cannot distinguish "not a git
      // repo" from "git timed out / failed and our helper returned empty
      // stdout"; preserving immediate retry on failures is more important
      // than negative-caching non-repos.
      entry.settled = true
      entry.expiresAt = cacheableResult ? Date.now() + WORKTREE_CACHE_TTL_MS : 0
    })
  worktreeListCache.set(cwd, entry)
  return cloneWorktrees(await entry.promise)
}

export async function getWorktreeStatusForCwd(cwd: string): Promise<GitWorktreeStatus[]> {
  const now = Date.now()
  const cached = worktreeStatusCache.get(cwd)
  if (cached && (!cached.settled || cached.expiresAt > now)) return cloneStatuses(await cached.promise)

  let cacheableResult = false
  const entry: CacheEntry<GitWorktreeStatus[]> = {
    expiresAt: 0,
    settled: false,
    promise: Promise.resolve([]),
  }
  entry.promise = computeWorktreeStatusForCwd(cwd)
    .then(statuses => {
      cacheableResult = statuses.length > 0
      if (cacheableResult) {
        seedCacheAliases(worktreeStatusCache, [
          cwd,
          ...statuses.map(worktree => worktree.path),
        ], entry)
      }
      return statuses
    })
    .catch(() => [])
    .finally(() => {
      entry.settled = true
      entry.expiresAt = cacheableResult ? Date.now() + WORKTREE_CACHE_TTL_MS : 0
    })
  worktreeStatusCache.set(cwd, entry)
  return cloneStatuses(await entry.promise)
}

async function computeWorktreeStatusForCwd(cwd: string): Promise<GitWorktreeStatus[]> {
  const worktrees = await listWorktreesForCwd(cwd)
  return await mapWithConcurrency(worktrees, WORKTREE_STATUS_CONCURRENCY, async worktree => {
    const branch = worktree.branch
    const [statusOut, lastCommitRaw] = await Promise.all([
      // WHY keep untracked-files=normal instead of the faster -uno:
      // the Worktrees panel is a cleanup tool, so brand-new files in an agent
      // branch are real user work and must keep the row "dirty". The expensive
      // part we can safely trim is submodule worktree inspection: for cleanup
      // triage, a submodule's recorded commit is the repository-level signal,
      // while scanning every submodule's own untracked/modified files across
      // many sibling worktrees multiplies filesystem work during orchestration.
      git(worktree.path, [
        'status',
        '--porcelain',
        '--untracked-files=normal',
        '--ignore-submodules=dirty',
      ]),
      git(worktree.path, ['log', '-1', '--format=%ct%x00%cr']),
    ])
    const dirty = statusOut.trim().length > 0
    const [lastCommitAtRaw = '', lastCommitRelativeRaw = ''] = lastCommitRaw.trim().split('\0')
    const lastCommitRelative = lastCommitRelativeRaw || null
    const lastCommitAt =
      /^\d+$/.test(lastCommitAtRaw) ? Number(lastCommitAtRaw) * 1000 : null

    let mergedToMain: boolean | null = null
    let ahead: number | null = null
    let behind: number | null = null
    let patchUniqueAhead: number | null = null
    if (branch && branch !== 'main') {
      const counts = parseRevListCounts(
        await git(cwd, ['rev-list', '--left-right', '--count', `main...${branch}`]),
      )
      behind = counts?.behind ?? null
      ahead = counts?.ahead ?? null
      if (ahead === 0) {
        mergedToMain = true
        patchUniqueAhead = 0
      } else if (ahead !== null) {
        mergedToMain = false
        // Raw ahead/behind is ancestry-based. Squash merges and
        // cherry-picks leave old branch commits "ahead" by SHA even
        // when their patches already exist on main. `git cherry`
        // answers the cleanup question we actually care about:
        // does this branch contain any patch-unique work? We only need it when
        // rev-list says the branch has commits ahead; ahead==0 is already the
        // cheap merged-to-main proof and avoids one subprocess per branch.
        patchUniqueAhead = parsePatchUniqueAhead(
          await git(cwd, ['cherry', 'main', branch]),
        )
      }
    } else if (branch === 'main') {
      mergedToMain = true
      ahead = 0
      behind = 0
      patchUniqueAhead = 0
    }

    const category: GitWorktreeStatus['category'] =
      branch === 'main'
        ? 'main'
        : worktree.detached
          ? 'detached'
          : dirty
            ? 'dirty'
            : mergedToMain === true && ahead === 0
              ? 'cleanup-merged'
              : patchUniqueAhead === 0 && (ahead ?? 0) > 0
                ? 'patch-equivalent'
                : (patchUniqueAhead ?? 0) > 0 && (behind ?? 0) > 0
                  ? 'stale-review'
                  : (patchUniqueAhead ?? 0) > 0
                    ? 'active-unmerged'
                    : 'review'

    return {
      ...worktree,
      dirty,
      mergedToMain,
      ahead,
      behind,
      patchUniqueAhead,
      lastCommitAt,
      lastCommitRelative,
      category,
    }
  })
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next
      next += 1
      out[index] = await mapper(items[index], index)
    }
  })
  await Promise.all(workers)
  return out
}

function cloneWorktrees(worktrees: WorktreeIdentity[]): WorktreeIdentity[] {
  return worktrees.map(worktree => ({ ...worktree }))
}

function cloneStatuses(worktrees: GitWorktreeStatus[]): GitWorktreeStatus[] {
  return worktrees.map(worktree => ({ ...worktree }))
}

// parseNumstat moved to @shared/git/numstat (pure + unit-tested). Imported above.

type SubmoduleInfo = GitSubmoduleStatus

// .gitmodules is the source of truth for which paths ARE submodules
// — `git submodule` the CLI needs the working tree checked out but
// `git config -f .gitmodules` just reads the file, which is enough
// for us. Gate on stat() first so we don't spawn a subprocess for
// repos with no submodules at all.
async function readSubmodulePaths(cwd: string): Promise<string[]> {
  const paths: string[] = []
  try {
    await stat(join(cwd, '.gitmodules'))
    const cfgOut = await git(cwd, [
      'config', '-f', '.gitmodules',
      '--get-regexp', '^submodule\\..*\\.path$',
    ])
    for (const line of cfgOut.split('\n')) {
      // Output line: "submodule.<name>.path <relative-path>"
      const m = /^submodule\.[^\s]+\.path\s+(.+)$/.exec(line)
      if (m) paths.push(m[1].trim())
    }
  } catch {
    // no .gitmodules → no submodules → leave list empty
  }
  return paths
}

async function inspectSubmodule(
  parentCwd: string,
  subPath: string,
): Promise<SubmoduleInfo | null> {
  const subAbs = join(parentCwd, subPath)

  // Parent-registered SHA. ls-tree line format:
  //   160000 commit <sha>\t<subPath>
  // If HEAD has no entry (fresh submodule not yet committed to
  // parent) we still classify by dirty-ness alone.
  const lsTree = await git(parentCwd, ['ls-tree', 'HEAD', subPath])
  const lsMatch = /\bcommit\s+([0-9a-f]{7,40})\b/.exec(lsTree)
  const registered = lsMatch ? lsMatch[1] : null

  const currentHead = (await git(subAbs, ['rev-parse', 'HEAD'])).trim()
  if (!currentHead) return null // not checked out → nothing to show

  const isBumped = !!registered && registered !== currentHead
  const statusOut = await git(subAbs, ['status', '--porcelain'])
  const isDirty = statusOut.trim().length > 0
  if (!isBumped && !isDirty) return null

  // Choose the diff argv based on state. Git semantics:
  //   diff <sha>           → compare <sha> to worktree
  //   diff <a>..<b>        → compare two commits, worktree ignored
  //   diff HEAD            → compare HEAD to worktree
  // "both" uses `diff <registered>` (single arg, no range) so the
  // worktree's dirty-on-top-of-new-commits is captured in one call.
  const diffArgs: string[] = isBumped && isDirty
    ? ['diff', registered!, '--numstat']
    : isBumped
      ? ['diff', `${registered}..HEAD`, '--numstat']
      : ['diff', 'HEAD', '--numstat']
  const files = parseNumstat(await git(subAbs, diffArgs))

  const state: SubmoduleInfo['state'] = isBumped && isDirty
    ? 'both' : isBumped ? 'bumped' : 'dirty'

  return {
    path: subPath,
    state,
    files,
    range: isBumped && registered
      ? { from: registered.slice(0, 7), to: currentHead.slice(0, 7) }
      : undefined,
  }
}

export function registerGitIpc(): void {
  ipcMain.handle('git:worktrees', async (_evt, cwd: string) => {
    try {
      const worktrees = await listWorktreesForCwd(cwd)
      if (worktrees.length === 0) throw new Error('not a git worktree')
      return { ok: true as const, worktrees }
    } catch {
      return { ok: false as const }
    }
  })

  ipcMain.handle('git:worktree-status', async (_evt, cwd: string) => {
    try {
      const worktrees = await getWorktreeStatusForCwd(cwd)
      if (worktrees.length === 0) throw new Error('not a git worktree')
      return { ok: true as const, worktrees }
    } catch {
      return { ok: false as const }
    }
  })

  // Return annotated with the shared contract so a field change here is a
  // compile error rather than silent drift from preload/renderer.
  ipcMain.handle('git:status', async (_evt, cwd: string): Promise<GitBarStatusResult> => {
    try {
      // Parent repo — branch is the cheap "is this a git repo at all"
      // probe; if it returns empty we bail to { ok: false } instead of
      // returning a half-filled shape.
      const branchOut = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
      if (!branchOut.trim()) throw new Error('not a git repo')

      const diffStat = await git(cwd, ['diff', 'HEAD', '--numstat'])
      const logOut = await git(cwd, ['log', '--oneline', '--format=%h\t%s\t%an\t%cr', '-5'])

      const submodulePaths = await readSubmodulePaths(cwd)
      const submodules: SubmoduleInfo[] = []
      for (const subPath of submodulePaths) {
        const info = await inspectSubmodule(cwd, subPath)
        if (info) submodules.push(info)
      }

      // Parent file list: drop gitlink lines for the submodule paths
      // we just surfaced in detail — showing them twice (once as
      // "+1 -1 on <path>" and once as a full submodule section) is
      // redundant.
      const submoduleSet = new Set(submodulePaths)
      const files = parseNumstat(diffStat).filter(f => !submoduleSet.has(f.file))

      const commits: GitRecentCommit[] = []
      for (const line of logOut.trim().split('\n')) {
        if (!line) continue
        const [hash, subject, author, relativeDate] = line.split('\t')
        if (!hash) continue
        commits.push({
          hash,
          subject: subject ?? '',
          author: author ?? '',
          relativeDate: relativeDate ?? '',
        })
      }

      return {
        ok: true as const,
        branch: branchOut.trim(),
        files,
        commits,
        // Undefined instead of [] when there are no changed
        // submodules so the renderer can cheaply gate on
        // `data.submodules?.length` without drawing an empty heading.
        submodules: submodules.length > 0 ? submodules : undefined,
      }
    } catch {
      return { ok: false as const }
    }
  })
}
