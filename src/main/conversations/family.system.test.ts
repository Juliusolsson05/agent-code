import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

import { normalizeCwd, resolveFamily } from './family.js'
import { corpusWorktreesPorcelain } from '../../../testing/support/conversations/installCorpus.js'

const exec = promisify(execFile)
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const c of cleanups.splice(0)) await c() })

// A real repository with a real `git worktree add`, because family resolution
// IS the upstream `includeWorktrees` behaviour Agent Code dropped and the
// porcelain parser must see git's actual output, not a hand-typed sample.
async function repoWithWorktree() {
  const root = await mkdtemp(join(tmpdir(), 'family-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const main = join(root, 'repo')
  await mkdir(main)
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: main })
  await writeFile(join(main, 'README.md'), 'x\n')
  await exec('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.'], { cwd: main })
  await exec('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd: main })
  await mkdir(join(main, '.worktrees'))
  await exec('git', ['worktree', 'add', '-q', join(main, '.worktrees', 'feature'), '-b', 'feature'], { cwd: main })
  const sibling = join(root, 'repo-audit')
  await exec('git', ['worktree', 'add', '-q', sibling, '-b', 'audit'], { cwd: main })
  return { main, feature: join(main, '.worktrees', 'feature'), sibling }
}

function gitWorktrees(cwd: string) {
  return exec('git', ['worktree', 'list', '--porcelain'], { cwd }).then(r =>
    r.stdout.split('\n').filter(l => l.startsWith('worktree ')).map(l => ({ path: l.slice('worktree '.length) })))
}

describe('repository family', () => {
  it('spans the main checkout, .worktrees children, subdirectories and sibling worktrees', async () => {
    const repo = await repoWithWorktree()
    const family = await resolveFamily(repo.feature, 'repository', { listWorktrees: gitWorktrees })
    // git prints realpaths (/private/var on macOS); the temp dir is /var.
    expect(family.root).toBe(normalizeCwd(await realpath(repo.main)))
    expect(family.matches(await realpath(repo.main))).toBe(true)
    expect(family.matches(repo.main)).toBe(true)
    expect(family.matches(repo.feature)).toBe(true)
    expect(family.matches(join(repo.main, 'packages', 'x'))).toBe(true)
    expect(family.matches(repo.sibling)).toBe(true)
    expect(family.matches(join(repo.main, '.worktrees', 'pruned-later'))).toBe(true)
    expect(family.matches(repo.main + '-other')).toBe(false)
    expect(family.matches(null)).toBe(false)
  })

  it('compares cwds case-insensitively on darwin and exactly by scope otherwise', async () => {
    const repo = await repoWithWorktree()
    const cwdScope = await resolveFamily(repo.main, 'cwd', { listWorktrees: gitWorktrees })
    expect(cwdScope.matches(repo.feature)).toBe(false)
    expect(cwdScope.matches(repo.main + '/')).toBe(true)
    if (process.platform === 'darwin') {
      // One real transcript records ~/Desktop/development/agent-code (lowercase d)
      // for a session that ran in ~/Desktop/Development/agent-code.
      expect(cwdScope.matches(repo.main.replace('repo', 'REPO'))).toBe(true)
    }
    const everywhere = await resolveFamily(repo.main, 'everywhere', { listWorktrees: gitWorktrees })
    expect(everywhere.matches('/somewhere/else')).toBe(true)
    expect(everywhere.root).toBe(normalizeCwd(await realpath(repo.main)))
  })

  it('falls back to the cwd alone when git is unavailable or the dir is not a repository', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'family-nogit-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const family = await resolveFamily(dir, 'repository', { listWorktrees: async () => [] })
    const real = await realpath(dir)
    expect(family.root).toBe(normalizeCwd(real))
    expect(family.roots).toEqual([...new Set([normalizeCwd(real), normalizeCwd(dir)])])
    expect(family.rawRoots[0]).toBe(real)
    expect(family.matches(join(dir, 'sub'))).toBe(true)
  })

  it('resolves the recorded corpus family from its porcelain output', async () => {
    const porcelain = await corpusWorktreesPorcelain()
    const worktrees = porcelain.split('\n').filter(l => l.startsWith('worktree ')).map(l => ({ path: l.slice('worktree '.length) }))
    const family = await resolveFamily('/fixture/repo/.worktrees/extension-platform', 'repository', { listWorktrees: async () => worktrees })
    expect(family.root).toBe('/fixture/repo')
    expect(family.matches('/fixture/repo/.worktrees/extension-platform')).toBe(true)
    expect(family.matches('/fixture/other-1')).toBe(false)
  })
})
