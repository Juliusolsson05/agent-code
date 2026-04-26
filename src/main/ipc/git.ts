import { ipcMain } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { join } from 'path'
import { stat } from 'fs/promises'
import type { GitWorktreeStatus, WorktreeIdentity } from '@shared/types/git'
import { getToolPath } from '@main/setup/toolchain.js'

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

type NumstatLine = { file: string; additions: number; deletions: number }

// Centralized git runner. Returns stdout; swallows errors and returns
// '' so callers can treat "no output" as a valid signal (clean
// worktree, missing HEAD, missing submodule checkout). Failing loudly
// here would cascade a single bad command into an overall
// { ok: false }, losing the rest of the data we CAN compute.
async function git(cwd: string, args: string[]): Promise<string> {
  try {
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
  const out = await git(cwd, ['worktree', 'list', '--porcelain'])
  if (!out.trim()) return []
  return parseWorktreePorcelain(out)
}

export async function getWorktreeStatusForCwd(cwd: string): Promise<GitWorktreeStatus[]> {
  const worktrees = await listWorktreesForCwd(cwd)
  return await Promise.all(worktrees.map(async worktree => {
    const branch = worktree.branch
    const dirty = (await git(worktree.path, ['status', '--porcelain'])).trim().length > 0
    const lastCommitAtRaw = (await git(worktree.path, ['log', '-1', '--format=%ct'])).trim()
    const lastCommitRelative = (await git(worktree.path, ['log', '-1', '--format=%cr'])).trim() || null
    const lastCommitAt =
      /^\d+$/.test(lastCommitAtRaw) ? Number(lastCommitAtRaw) * 1000 : null

    let mergedToMain: boolean | null = null
    let ahead: number | null = null
    let behind: number | null = null
    if (branch && branch !== 'main') {
      mergedToMain = await new Promise<boolean>(resolve => {
        execFile(
          getToolPath('git', 'git'),
          ['merge-base', '--is-ancestor', branch, 'main'],
          { cwd, timeout: 5000 },
          err => resolve(!err),
        )
      })
      const counts = parseRevListCounts(
        await git(cwd, ['rev-list', '--left-right', '--count', `main...${branch}`]),
      )
      behind = counts?.behind ?? null
      ahead = counts?.ahead ?? null
    } else if (branch === 'main') {
      mergedToMain = true
      ahead = 0
      behind = 0
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
              : mergedToMain === false && (ahead ?? 0) > 0
                ? 'active-unmerged'
                : 'review'

    return {
      ...worktree,
      dirty,
      mergedToMain,
      ahead,
      behind,
      lastCommitAt,
      lastCommitRelative,
      category,
    }
  }))
}

// numstat → rows. Binary files emit '-' for both counts; we coerce
// those to 0 so the UI doesn't special-case them.
function parseNumstat(text: string): NumstatLine[] {
  const out: NumstatLine[] = []
  for (const line of text.trim().split('\n')) {
    if (!line) continue
    const [a, d, f] = line.split('\t')
    if (!f) continue
    out.push({
      file: f,
      additions: a === '-' ? 0 : parseInt(a, 10) || 0,
      deletions: d === '-' ? 0 : parseInt(d, 10) || 0,
    })
  }
  return out
}

type SubmoduleInfo = {
  path: string
  state: 'dirty' | 'bumped' | 'both'
  files: NumstatLine[]
  range?: { from: string; to: string }
}

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

  ipcMain.handle('git:status', async (_evt, cwd: string) => {
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

      const commits: Array<{
        hash: string
        subject: string
        author: string
        relativeDate: string
      }> = []
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
