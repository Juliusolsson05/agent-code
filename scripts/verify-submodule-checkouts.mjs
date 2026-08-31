import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

/** Parse stage-zero gitlinks from `git ls-files --stage -z`. */
export function parseGitlinks(output) {
  const links = []
  for (const record of output.split('\0')) {
    if (!record) continue
    const match = /^160000 ([0-9a-f]{40,64}) \d+\t(.+)$/.exec(record)
    if (!match) continue
    links.push({ expectedHead: match[1].toLowerCase(), path: match[2] })
  }
  return links
}

/**
 * Classify source drift without collapsing distinct remediation paths.
 *
 * WHY dirty and mismatched are separate failures: `git submodule status`
 * prefixes both with punctuation that is easy to misread, but they mean
 * different things. A mismatch needs the pinned commit checked out; a dirty
 * tree already has the right commit and needs its local edits committed or
 * removed. Calling both merely "dirty" is how the running app compiled an old
 * Codex package while the parent repository looked current.
 */
export function classifySubmoduleCheckouts(gitlinks, observations) {
  const failures = []
  for (const link of gitlinks) {
    const observed = observations.get(link.path)
    if (!observed?.initialized || !observed.head) {
      failures.push({ kind: 'uninitialized', ...link })
      continue
    }
    if (observed.head.toLowerCase() !== link.expectedHead) {
      failures.push({
        kind: 'mismatch',
        ...link,
        actualHead: observed.head.toLowerCase(),
      })
    }
    if (observed.dirty) {
      failures.push({
        kind: 'dirty',
        ...link,
        actualHead: observed.head.toLowerCase(),
      })
    }
  }
  return failures
}

export function formatSubmoduleFailure(failures) {
  const lines = [
    'Submodule checkout verification failed; refusing to compile unpinned source.',
    '',
  ]
  for (const failure of failures) {
    if (failure.kind === 'uninitialized') {
      lines.push(`UNINITIALIZED ${failure.path} (expected ${failure.expectedHead})`)
    } else if (failure.kind === 'mismatch') {
      lines.push(
        `MISMATCH     ${failure.path}`,
        `  expected: ${failure.expectedHead}`,
        `  actual:   ${failure.actualHead}`,
      )
    } else {
      lines.push(
        `DIRTY        ${failure.path} at ${failure.actualHead}`,
        '  Commit/stash those edits before building a provenance-safe app.',
      )
    }
  }
  const repairablePaths = [...new Set(
    failures
      .filter(failure => failure.kind !== 'dirty')
      .map(failure => failure.path),
  )]
  if (repairablePaths.length > 0) {
    lines.push(
      '',
      'Restore pinned commits with:',
      `  git submodule update --init --recursive -- ${repairablePaths.join(' ')}`,
    )
  }
  return lines.join('\n')
}

function runGit(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

export function verifySubmoduleCheckouts(repoRoot) {
  const gitlinks = parseGitlinks(runGit(repoRoot, ['ls-files', '--stage', '-z']))
  const observations = new Map()
  for (const link of gitlinks) {
    const submoduleRoot = resolve(repoRoot, link.path)
    try {
      const reportedRoot = resolve(runGit(submoduleRoot, ['rev-parse', '--show-toplevel']))
      // WHY root equality is load-bearing: in an uninitialized submodule's
      // empty directory Git walks upward and happily reports the PARENT repo's
      // HEAD. Treating that as the child HEAD can produce a plausible-looking
      // mismatch instead of identifying the missing checkout.
      if (reportedRoot !== submoduleRoot) {
        observations.set(link.path, { initialized: false })
        continue
      }
      observations.set(link.path, {
        initialized: true,
        head: runGit(submoduleRoot, ['rev-parse', 'HEAD']),
        dirty: runGit(
          submoduleRoot,
          ['status', '--porcelain', '--untracked-files=all'],
        ).length > 0,
      })
    } catch {
      observations.set(link.path, { initialized: false })
    }
  }

  const failures = classifySubmoduleCheckouts(gitlinks, observations)
  if (failures.length > 0) throw new Error(formatSubmoduleFailure(failures))
  return gitlinks.length
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null
if (invokedPath === fileURLToPath(import.meta.url)) {
  const repoRoot = runGit(dirname(fileURLToPath(import.meta.url)), ['rev-parse', '--show-toplevel'])
  try {
    const count = verifySubmoduleCheckouts(repoRoot)
    console.log(`Verified ${count} pinned submodule checkout${count === 1 ? '' : 's'}.`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
