import { realpathSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'

import type { ConversationScope } from '@shared/conversations/types.js'

// Which conversations belong to "this repository".
//
// WHY worktrees are the unit, not the cwd (docs/decomposition/conversations.md
// §2.1): Claude keys its transcript directories by cwd, so a session run in
// `.worktrees/feature` is invisible from the main checkout. Upstream Claude
// Code's own picker merges every `git worktree list` path; the app-side copy
// of that lister dropped the feature and the user lost half their sessions.
//
// WHY the main checkout is the first porcelain entry: git prints the main
// worktree first, always. When git is unavailable the cwd itself is the root.
//
// WHY prefix matching under each root: a session started in
// `<repo>/packages/x` is still this repository, and a pruned
// `<repo>/.worktrees/old` still holds transcripts worth listing. Prefix
// matching is exact on the path separator so `<repo>-other` never matches.
//
// WHY every root is kept in BOTH its literal and its realpath form: git
// prints realpaths (`/private/var/...` on macOS) while providers record the
// literal cwd the process was started in (`/var/...`), and Claude Code names
// its project directory from the realpath (sessionStoragePortable's
// canonicalizePath). Matching candidates against either form, without a
// syscall per candidate, keeps `matches` cheap over thousands of rows.

export type RepositoryFamily = {
  scope: ConversationScope
  cwd: string
  /** Normalised main-checkout path (the cwd itself when git is unavailable). */
  root: string | null
  /** Every normalised root that counts as this repository. */
  roots: string[]
  /** The same roots with their on-disk case preserved. Claude derives its
   *  project directory name from the literal cwd, so a lowercased root
   *  would name a directory that does not exist. */
  rawRoots: string[]
  matches(candidate: string | null | undefined): boolean
}

export type FamilyDeps = {
  listWorktrees(cwd: string): Promise<ReadonlyArray<{ path: string }>>
}

/** `path.resolve` collapses `..` and trailing slashes; darwin and win32 file
 *  systems are case-insensitive by default, and one real transcript recorded
 *  the cwd with a lowercased segment. */
export function normalizeCwd(path: string): string {
  const resolved = resolve(path).replace(/\/+$/, '')
  return process.platform === 'darwin' || process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function underRoot(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root + '/')
}

/** Literal-resolved and realpath forms of a path, realpath first when the
 *  path exists (it is the canonical one), deduplicated. */
function forms(path: string): string[] {
  const literal = resolve(path).replace(/\/+$/, '')
  try {
    const real = realpathSync.native(literal).replace(/\/+$/, '')
    return real === literal ? [literal] : [real, literal]
  } catch {
    return [literal]
  }
}

export async function resolveFamily(
  cwd: string,
  scope: ConversationScope,
  deps: FamilyDeps,
): Promise<RepositoryFamily> {
  const cwdForms = forms(cwd)
  const cwdRoots = cwdForms.map(normalizeCwd)
  let worktreeForms: string[][] = []
  try {
    worktreeForms = (await deps.listWorktrees(cwd)).map(w => forms(w.path))
  } catch {
    worktreeForms = []
  }
  const rawRoots = scope === 'cwd'
    ? cwdForms
    : [...new Set([...(worktreeForms[0] ?? cwdForms), ...worktreeForms.flat()])]
  const roots = [...new Set(rawRoots.map(normalizeCwd))]
  const root = normalizeCwd((worktreeForms[0] ?? cwdForms)[0]!)
  // A candidate recorded through a symlinked prefix (`/var/...`, `/tmp/...`)
  // only matches after realpath. That is one syscall per DISTINCT cwd, cached
  // for the life of this family; a non-existent path (deleted worktree, or
  // the fixture corpus) caches its miss and never pays again.
  const realCache = new Map<string, string | null>()
  const realFormOf = (candidate: string): string | null => {
    const cached = realCache.get(candidate)
    if (cached !== undefined) return cached
    // A path that no longer exists (a pruned worktree, a deleted
    // subdirectory) still has a canonical form: realpath its nearest existing
    // ancestor and re-append what was cut. Stops at the filesystem root.
    let real: string | null = null
    let head = resolve(candidate)
    const tail: string[] = []
    for (;;) {
      try {
        real = normalizeCwd([realpathSync.native(head), ...tail].join('/'))
        break
      } catch {
        const parent = dirname(head)
        if (parent === head) break
        tail.unshift(basename(head))
        head = parent
      }
    }
    realCache.set(candidate, real)
    return real
  }
  const matchesNormalized = (c: string): boolean =>
    scope === 'cwd' ? cwdRoots.includes(c) : roots.some(r => underRoot(c, r))
  return {
    scope,
    cwd: cwdRoots[0]!,
    root,
    roots,
    rawRoots,
    matches(candidate) {
      if (scope === 'everywhere') return true
      if (!candidate) return false
      const c = normalizeCwd(candidate)
      if (matchesNormalized(c)) return true
      const real = realFormOf(candidate)
      return real !== null && real !== c && matchesNormalized(real)
    },
  }
}
