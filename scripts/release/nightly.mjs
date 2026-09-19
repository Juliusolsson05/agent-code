#!/usr/bin/env node
// The nightly release workflow's decision, rename and release-notes logic
// (.github/workflows/nightly.yml, #1011).
//
// WHY this is a script and not inline workflow bash: the first version lived
// in YAML `run:` blocks, where nothing could exercise it, and the PR #1012
// review found real defects there:
//   - a body saved through the web UI comes back with CRLF, and the trailing
//     \r stopped the marker from ever matching, so every night rebuilt;
//   - a previous SHA missing from the clone made `git log` exit 128 after a
//     full 26-minute build, on every later run;
//   - the marker was written before the uploads, so a failed upload was
//     skipped over forever.
// As a script, testing/system/release/nightly.test.ts runs it as a real
// process against RECORDED GitHub payloads (testing/fixtures/release-nightly)
// and a real git repository. The workflow calls exactly this entry point.
//
// Subcommands (all configuration through the env the workflow already has):
//   decide        needs GITHUB_SHA, GITHUB_REPOSITORY, FORCE and GITHUB_OUTPUT
//                 → writes changed, head-sha and prev-sha
//   rename <dir>  versioned electron-builder artifacts → fixed nightly names
//   notes <dir>   needs HEAD_SHA, PREV_SHA, GITHUB_REPOSITORY and
//                 GITHUB_SERVER_URL → writes nightly-body-publishing.md and
//                 nightly-body.md
//
// Only Node built-ins, so the Ubuntu jobs need no `npm ci`.

import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const NIGHTLY_TAG = 'nightly'
export const NIGHTLY_ARCHES = ['arm64', 'x64']
// Fixed names, spelled the way GitHub stores them: an uploaded "Agent Code-…"
// becomes "Agent.Code-…", and the landing page matches on the `-<arch>.dmg`
// suffix. These four names are the rolling-release contract. Every other file
// the build produces is deliberately not published.
export const NIGHTLY_ASSET_NAMES = NIGHTLY_ARCHES.flatMap(arch => [
  `Agent.Code-nightly-${arch}.dmg`,
  `Agent.Code-nightly-${arch}.zip`,
])

const SHA = /^[0-9a-f]{40}$/

// Cap on the commit list in a release body. GitHub rejects bodies over
// 125,000 characters, and this repo lands about 1,100 commits a month at
// about 77 characters each, so a few weeks of failed nightlies would
// overflow. softprops would silently truncate the publishing body, and the
// final `gh release edit` would then be rejected after a full build. 200
// lines is ~15 KB; the compare link carries the rest.
export const NOTES_MAX_COMMITS = 200

/** The SHA this nightly was built from. Returns the first `built-from:` line
 * that carries an exact 40-hex SHA, or '' when there is none.
 *
 * Line endings are normalised first: GitHub stores bodies saved through its
 * web UI with CRLF (the recorded react release proves it), and a trailing \r
 * made the old inline `sed` parse never equal HEAD. Anything that is not an
 * exact SHA is treated as "no marker", which safely means "rebuild". */
export function parseBuiltFrom(body) {
  for (const line of String(body ?? '').split(/\r?\n/)) {
    const match = /^built-from: ([0-9a-f]{40})$/.exec(line.trimEnd())
    if (match) return match[1]
  }
  return ''
}

/** The fixed nightly assets that are missing or not fully uploaded. A marker
 * alone does not prove the release is complete: a publish can fail between
 * softprops deleting an old asset and uploading its replacement. */
export function incompleteAssets(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : []
  return NIGHTLY_ASSET_NAMES.filter(name => !assets.some(asset => asset.name === name && asset.state === 'uploaded'))
}

/** Pure decision over an already-fetched release (null = no nightly yet). */
export function decide({ release, headSha, force }) {
  const prevSha = release ? parseBuiltFrom(release.body) : ''
  const missing = release ? incompleteAssets(release) : [...NIGHTLY_ASSET_NAMES]
  const complete = release !== null && missing.length === 0
  const changed = force || !prevSha || prevSha !== headSha || !complete
  return { changed, prevSha, missing }
}

/** GET the nightly release through `gh` (already authenticated in the job).
 *
 * Only a 404 means "no nightly yet". Any other failure (rate limit, 5xx, bad
 * token) throws. Treating every error as "no nightly" turned a transient API
 * hiccup into a 26-minute rebuild whose notes were mislabelled as the first
 * nightly. */
function fetchNightlyRelease(repo) {
  const result = spawnSync('gh', ['api', `repos/${repo}/releases/tags/${NIGHTLY_TAG}`], { encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status === 0) return JSON.parse(result.stdout)
  if (/HTTP 404/.test(result.stderr)) return null
  throw new Error(`gh api failed (exit ${result.status}): ${result.stderr.trim() || result.stdout.trim()}`)
}

function writeOutputs(outputs) {
  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join('')
  // GITHUB_OUTPUT is always set inside Actions. Printing is for a person
  // running this by hand.
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines)
  else process.stdout.write(lines)
}

function commandDecide() {
  const headSha = process.env.GITHUB_SHA ?? ''
  const repo = process.env.GITHUB_REPOSITORY ?? ''
  if (!SHA.test(headSha)) throw new Error(`GITHUB_SHA is not a 40-hex commit SHA: "${headSha}"`)
  if (!repo) throw new Error('GITHUB_REPOSITORY is not set')
  const force = process.env.FORCE === 'true'
  const release = fetchNightlyRelease(repo)
  const { changed, prevSha, missing } = decide({ release, headSha, force })
  for (const name of release ? missing : []) console.log(`Nightly asset missing or incomplete: ${name}`)
  writeOutputs({ changed: String(changed), 'head-sha': headSha, 'prev-sha': prevSha })
  console.log(changed
    ? `Nightly needed: ${prevSha || '<no previous marker>'} -> ${headSha} (force=${force}, incomplete=${missing.length})`
    : `No commits on ${process.env.GITHUB_REF_NAME ?? 'the ref'} since the last complete nightly (${prevSha}); skipping.`)
}

/** Rename each architecture's single dmg and zip onto the fixed names, and
 * drop the updater metadata. Blockmaps and latest-mac.yml refer to the
 * versioned filenames, and the app has no update channel reading a rolling
 * nightly.
 *
 * Refuses rather than guesses when an architecture has zero or several
 * candidates: publishing the wrong binary under a stable URL is worse than a
 * red run. */
function commandRename(dir) {
  if (!dir) throw new Error('usage: nightly.mjs rename <dir>')
  const files = readdirSync(dir)
  for (const arch of NIGHTLY_ARCHES) {
    for (const ext of ['dmg', 'zip']) {
      const candidates = files.filter(name => name.endsWith(`-${arch}.${ext}`) && !name.startsWith('Agent.Code-nightly-'))
      if (candidates.length !== 1) {
        throw new Error(`Expected exactly one ${arch} .${ext}, found ${candidates.length}: ${JSON.stringify(candidates)} (all files: ${JSON.stringify(files)})`)
      }
      renameSync(join(dir, candidates[0]), join(dir, `Agent.Code-nightly-${arch}.${ext}`))
    }
  }
  for (const name of readdirSync(dir)) {
    if (name.endsWith('.blockmap') || name === 'latest-mac.yml') rmSync(join(dir, name))
  }
  console.log(readdirSync(dir).join('\n'))
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' })
}

function isReachableCommit(sha) {
  if (!SHA.test(sha)) return false
  return spawnSync('git', ['cat-file', '-e', `${sha}^{commit}`]).status === 0
}

/** Two bodies. The PUBLISHING body has no marker and is posted with the
 * assets. The FINAL body carries `built-from:` as its first line and is
 * written only after every upload succeeded, so a failed publish leaves no
 * marker for this SHA and the next run rebuilds instead of skipping. */
function commandNotes(outDir) {
  if (!outDir) throw new Error('usage: nightly.mjs notes <outDir>')
  const headSha = process.env.HEAD_SHA ?? ''
  const prevSha = process.env.PREV_SHA ?? ''
  const repo = process.env.GITHUB_REPOSITORY ?? ''
  const server = process.env.GITHUB_SERVER_URL ?? 'https://github.com'
  if (!SHA.test(headSha)) throw new Error(`HEAD_SHA is not a 40-hex commit SHA: "${headSha}"`)

  // The previous SHA may not be in this clone: a force-pushed or deleted
  // branch, or a hand-edited body. That used to crash `git log` under set -e
  // after a full build. It is only notes, so fall back to recent history.
  let commits
  if (isReachableCommit(prevSha)) {
    const total = Number(git(['rev-list', '--count', `${prevSha}..${headSha}`]).trim())
    const listed = git(['log', '--oneline', `--max-count=${NOTES_MAX_COMMITS}`, `${prevSha}..${headSha}`]).trimEnd()
    commits = ['### Commits since the previous nightly', listed]
    if (total > NOTES_MAX_COMMITS) {
      commits.push('', `_Showing the newest ${NOTES_MAX_COMMITS} of ${total}. Full list: ${server}/${repo}/compare/${prevSha}...${headSha}_`)
    }
  } else {
    commits = ['### Recent commits', '_No reachable previous nightly. The last 30 commits:_', git(['log', '--oneline', '-30', headSha]).trimEnd()]
  }

  const notes = [
    `Rolling nightly build of [\`${headSha.slice(0, 12)}\`](${server}/${repo}/tree/${headSha}), signed and notarized. Asset names are fixed, so links stay stable across builds. This is a prerelease build of \`main\`. Stable releases, when published, are listed on the Releases page.`,
    '',
    // Honest about the rolling tag. GitHub's "Source code" archives and
    // "commits since this release" follow the `nightly` TAG, which stays at
    // the first nightly's commit, because moving a published tag breaks
    // anyone who pinned it. The tree link above is this build's source.
    '> The `nightly` tag and the "Source code" archives point at the first nightly\'s commit, not this build. Use the tree link above for this build\'s source.',
    '',
    ...commits,
    '',
  ].join('\n')

  writeFileSync(join(outDir, 'nightly-body-publishing.md'), `publishing: ${headSha}\n\n${notes}`)
  writeFileSync(join(outDir, 'nightly-body.md'), `built-from: ${headSha}\n\n${notes}`)
}

const commands = { decide: commandDecide, rename: commandRename, notes: commandNotes }

// Run only when executed directly, so the helpers can be imported (the
// system tests import NOTES_MAX_COMMITS). Both sides go through realpath:
// import.meta.url resolves symlinks but process.argv[1] does not, so a
// symlinked checkout made the plain comparison false. The script then did
// NOTHING and exited 0, and a silent `decide` looks exactly like a green skip
// (verification review).
const invokedDirectly = (() => {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1] ?? '')
  } catch {
    return false
  }
})()
if (invokedDirectly) {
  const [name, arg] = process.argv.slice(2)
  const command = commands[name]
  if (!command) {
    console.error(`usage: nightly.mjs <${Object.keys(commands).join('|')}> [arg]`)
    process.exit(2)
  }
  try {
    command(arg)
  } catch (error) {
    console.error(`[nightly] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
