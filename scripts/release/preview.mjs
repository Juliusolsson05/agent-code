#!/usr/bin/env node
// The preview release workflow's logic (.github/workflows/preview.yml).
//
// WHAT a preview is (RELEASE.md, "Channels"): every night `main` is built as a
// prerelease of the NEXT version, for example `0.1.4-preview.20260924` after
// stable 0.1.3, and published twice:
//   - a DATED prerelease `v0.1.4-preview.20260924`, so the Releases page shows
//     what each night was, sorted where it belongs, with the version the app
//     itself reports;
//   - the ROLLING `preview` release with fixed asset names
//     (`Agent.Code-preview-arm64.dmg`, …), so one link always gives the newest
//     preview.
// This replaced the rolling-only `nightly` release (#1011). That release kept
// its first creation date forever, so the Releases page listed it as
// "2026-09-19" beneath every stable release and it read as abandoned even
// though its assets were rebuilt nightly. It also stamped the STABLE version
// into newer code, so a nightly installed after 0.1.3 claimed to be 0.1.3.
//
// WHY this is a script and not inline workflow bash (unchanged from the
// nightly, #1012 review): logic in YAML `run:` blocks cannot be exercised, and
// the review found real defects there — a CRLF body that never matched the
// marker, an unreachable previous SHA crashing `git log`, a marker written
// before the uploads. testing/system/release/preview.test.ts runs this file as
// a real process against RECORDED GitHub payloads and a real git repository.
//
// Subcommands (configuration through the env the workflow already has):
//   decide        GITHUB_SHA, GITHUB_REPOSITORY, GITHUB_EVENT_NAME, FORCE,
//                 TARGET ('patch' | 'minor'), GITHUB_OUTPUT; reads
//                 package.json in the working directory
//                 → changed, head-sha, prev-sha, version, tag
//   rename <dir>  keeps electron-builder's versioned dmg/zip (the dated
//                 release's assets), adds the fixed-name rolling copies, and
//                 drops updater metadata
//   notes <dir>   HEAD_SHA, PREV_SHA, VERSION, GITHUB_REPOSITORY,
//                 GITHUB_SERVER_URL → preview-body-publishing.md,
//                 preview-body.md, preview-dated-body.md
//   prune         GITHUB_REPOSITORY → deletes dated previews past retention
//                 and the retired `nightly` release
//
// Only Node built-ins, so the Ubuntu jobs need no `npm ci`.

import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, copyFileSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The rolling release that always holds the newest preview. */
export const PREVIEW_ROLLING_TAG = 'preview'
/** The rolling-only release this workflow replaced; `prune` retires it. */
export const LEGACY_NIGHTLY_TAG = 'nightly'
export const PREVIEW_ARCHES = ['arm64', 'x64']
// Fixed names for the rolling release: one link that always downloads the
// newest preview. The dotted "Agent.Code-" spelling matches every other
// published asset (GitHub stored "Agent Code-…" uploads as "Agent.Code-…"
// before #1129), and the `-<arch>.dmg` ending is what download pages match.
/** The Preview channel's update feed on the rolling release (#1168). The
 * generic provider asks for `<channel>-mac.yml`, with channel `preview`. */
export const PREVIEW_FEED_NAME = 'preview-mac.yml'
// The feed counts toward "complete" (#1168): a rolling release without it
// downloads fine by hand but cannot update anyone on the Preview channel, so
// the skip check must rebuild rather than skip over it.
export const PREVIEW_ROLLING_ASSET_NAMES = [
  ...PREVIEW_ARCHES.flatMap(arch => [
    `Agent.Code-preview-${arch}.dmg`,
    `Agent.Code-preview-${arch}.zip`,
  ]),
  PREVIEW_FEED_NAME,
]
/** `v0.1.4-preview.20260924.915` (built at 09:15 UTC; the first previews,
 * before #1168, had no time). Only tags of exactly this shape are ever pruned. */
export const PREVIEW_TAG = /^v\d+\.\d+\.\d+-preview\.\d{8}(?:\.\d{1,4})?$/

// Retention for dated previews. Two weeks of nights is enough to bisect "it
// broke sometime this week" by installing older previews, and the newest few
// are always kept so a quiet fortnight (no commits → no new previews) never
// leaves the Releases page without one.
export const PREVIEW_KEEP_DAYS = 14
export const PREVIEW_KEEP_MIN = 3

const SHA = /^[0-9a-f]{40}$/
const STABLE_VERSION = /^(\d+)\.(\d+)\.(\d+)$/

// Cap on the commit list in a release body. GitHub rejects bodies over
// 125,000 characters, and this repo lands about 1,100 commits a month at
// about 77 characters each, so a few weeks of failed runs would overflow.
// softprops would silently truncate the publishing body, and the final
// `gh release edit` would then be rejected after a full build. 200 lines is
// ~15 KB; the compare link carries the rest.
export const NOTES_MAX_COMMITS = 200

/**
 * The version a preview of `stableVersion` is built as.
 *
 * WHY the next PATCH by default (RELEASE.md "Version numbers": default to
 * PATCH): almost every next stable release is a patch, so the preview is a
 * preview of what will actually ship. If the next stable turns out to be a
 * minor, every `0.1.4-preview.*` still sorts below `0.2.0` and preview users
 * are offered it normally; `target: 'minor'` (manual runs only) labels the
 * previews for a planned minor honestly.
 *
 * WHY the UTC date AND time on every build, and not a counter: a counter
 * needs the previous number and a reset rule; a timestamp is unique, says how
 * fresh the build is, and — the property the Preview update channel relies on
 * (#1168) — sorts in BUILD ORDER. The updater only offers a preview newer
 * than the running one and never downgrades, so version order must equal
 * build order: with a bare date for scheduled runs, a manual run at 09:00
 * (`…20260924.900`) sorted above that day's later scheduled build
 * (`…20260924`), and Preview users on it were never offered that build
 * (review round 1). The time is a plain number because semver forbids leading
 * zeros in numeric identifiers (`0915` is not valid); numeric comparison still
 * orders it correctly.
 */
export function previewVersion({ stableVersion, target = 'patch', now }) {
  // A prerelease in package.json (RELEASE.md forbids it now that manual
  // releases are stable-only) previews its own core: 0.1.4-beta.1 → 0.1.4.
  const core = String(stableVersion ?? '').split('+')[0].split('-')[0]
  const match = STABLE_VERSION.exec(core)
  if (!match) throw new Error(`package.json version is not MAJOR.MINOR.PATCH: "${stableVersion}"`)
  const [major, minor, patch] = match.slice(1).map(Number)
  const isPrerelease = core !== String(stableVersion).split('+')[0]
  let next
  if (target === 'minor') next = `${major}.${minor + 1}.0`
  else if (target === 'patch') next = isPrerelease ? core : `${major}.${minor}.${patch + 1}`
  else throw new Error(`Unknown preview target "${target}"; use patch or minor.`)
  const date = now.toISOString().slice(0, 10).replaceAll('-', '')
  return `${next}-preview.${date}.${now.getUTCHours() * 100 + now.getUTCMinutes()}`
}

/** The SHA this preview was built from. Returns the first `built-from:` line
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

/** The fixed rolling assets that are missing or not fully uploaded. A marker
 * alone does not prove the release is complete: a publish can fail between
 * softprops deleting an old asset and uploading its replacement. */
export function incompleteAssets(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : []
  return PREVIEW_ROLLING_ASSET_NAMES.filter(name => !assets.some(asset => asset.name === name && asset.state === 'uploaded'))
}

/** Pure decision over the already-fetched rolling release (null = none yet).
 *
 * WHY a non-patch target always builds (review round 1): the skip marker
 * records only the commit, so a `target=minor` dispatch on an unchanged
 * `main` used to be a green run that published nothing. Choosing minor is an
 * explicit request for a differently labelled build. */
export function decide({ release, headSha, force, target = 'patch' }) {
  const prevSha = release ? parseBuiltFrom(release.body) : ''
  const missing = release ? incompleteAssets(release) : [...PREVIEW_ROLLING_ASSET_NAMES]
  const complete = release !== null && missing.length === 0
  const changed = force || target !== 'patch' || !prevSha || prevSha !== headSha || !complete
  return { changed, prevSha, missing }
}

/**
 * Refuses to publish a dated preview over one built from ANOTHER commit.
 *
 * WHY (review round 1, both reviewers): the version is dated by the clock at
 * decide time, but "Re-run all jobs" on an older run keeps that run's commit.
 * Re-running yesterday's failed run after today's succeeded produced today's
 * tag for yesterday's commit, and softprops then replaced today's assets and
 * notes with the older build while the tag still pointed at today's commit.
 * A dated release is created with `target_commitish` = the built SHA, so a
 * mismatch proves the collision. The same commit is fine: that is a genuine
 * retry of the same build.
 */
export function datedCollision({ dated, headSha, tag }) {
  if (!dated || dated.target_commitish === headSha) return null
  return `${tag} already exists for commit ${String(dated.target_commitish).slice(0, 12)}, not ${headSha.slice(0, 12)}. `
    + 'This is usually "Re-run all jobs" on an older run; start a new run of the workflow instead.'
}

/**
 * Which dated previews `prune` deletes: every preview-shaped tag older than
 * the retention window, except the newest `keepMin`, plus the retired
 * `nightly` release.
 *
 * WHY only exact preview-shaped tags are candidates: this runs with a token
 * that can delete ANY release. A stable `v0.1.3`, a hand-cut
 * `v0.0.2-beta.1` or anything unexpected must be impossible to match, so the
 * filter is the regex, never "prerelease: true".
 */
export function selectPrunable(releases, { now, keepDays = PREVIEW_KEEP_DAYS, keepMin = PREVIEW_KEEP_MIN }) {
  // WHY `published` and not `created` (review round 1): a release's
  // `created_at` is the date of the COMMIT it was made from, not when it was
  // published, so a preview of an older commit looked old the moment it was
  // published and could be deleted by the same run. A release with no valid
  // publication time (a draft) is never a candidate.
  const published = release => Date.parse(release.published ?? '')
  const previews = releases
    .filter(release => PREVIEW_TAG.test(release.tag) && Number.isFinite(published(release)))
    .sort((left, right) => published(right) - published(left))
  const cutoff = now.getTime() - keepDays * 24 * 60 * 60 * 1000
  const expired = previews.slice(keepMin).filter(release => published(release) < cutoff)
  const legacy = releases.filter(release => release.tag === LEGACY_NIGHTLY_TAG)
  return [...expired, ...legacy].map(release => release.tag)
}

/** GET one release by tag through `gh` (already authenticated in the job).
 *
 * Only a 404 means "no release yet". Any other failure (rate limit, 5xx, bad
 * token) throws. Treating every error as "missing" turned a transient API
 * hiccup into a 26-minute rebuild whose notes were mislabelled as the first
 * build. */
function fetchRelease(repo, tag) {
  const result = spawnSync('gh', ['api', `repos/${repo}/releases/tags/${tag}`], { encoding: 'utf8' })
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

/** `NOW` exists for the system tests (a fixed clock); the workflow never sets it. */
function now() {
  const value = process.env.NOW ? new Date(process.env.NOW) : new Date()
  if (Number.isNaN(value.getTime())) throw new Error(`NOW is not a valid date: "${process.env.NOW}"`)
  return value
}

function commandDecide() {
  const headSha = process.env.GITHUB_SHA ?? ''
  const repo = process.env.GITHUB_REPOSITORY ?? ''
  if (!SHA.test(headSha)) throw new Error(`GITHUB_SHA is not a 40-hex commit SHA: "${headSha}"`)
  if (!repo) throw new Error('GITHUB_REPOSITORY is not set')
  // Previews are builds of `main` (RELEASE.md). A dispatch from another
  // branch would replace the rolling "newest" download with an unreviewed
  // branch build whose notes say `main` (review round 1).
  if ((process.env.GITHUB_REF ?? 'refs/heads/main') !== 'refs/heads/main') {
    throw new Error(`Previews are built from main only, not ${process.env.GITHUB_REF}. Run the workflow with --ref main.`)
  }
  const force = process.env.FORCE === 'true'
  const target = process.env.TARGET || 'patch'
  const version = previewVersion({
    stableVersion: JSON.parse(readFileSync('package.json', 'utf8')).version,
    target,
    now: now(),
  })
  const release = fetchRelease(repo, PREVIEW_ROLLING_TAG)
  const { changed, prevSha, missing } = decide({ release, headSha, force, target })
  if (changed) {
    const collision = datedCollision({ dated: fetchRelease(repo, `v${version}`), headSha, tag: `v${version}` })
    if (collision) throw new Error(collision)
  }
  for (const name of release ? missing : []) console.log(`Preview asset missing or incomplete: ${name}`)
  // `rolling`: whether this build goes to the rolling release, the Preview
  // update channel's feed. A minor-labelled build (`0.2.0-preview.…`) does
  // not: it would sort above every later nightly `0.1.4-preview.*`, and
  // Preview users who took it would never be offered those (review round 1).
  // It is published as its own dated release only.
  writeOutputs({
    changed: String(changed), 'head-sha': headSha, 'prev-sha': prevSha,
    version, tag: `v${version}`, rolling: String(target === 'patch'),
  })
  console.log(changed
    ? `Preview ${version} needed: ${prevSha || '<no previous marker>'} -> ${headSha} (force=${force}, incomplete=${missing.length})`
    : `No commits on ${process.env.GITHUB_REF_NAME ?? 'the ref'} since the last complete preview (${prevSha}); skipping.`)
}

/** The rolling release's update feed (#1168), which the in-app updater reads
 * on the Preview channel through electron-updater's generic provider.
 *
 * electron-builder writes a feed (`latest-mac.yml`: version, and every file
 * with its sha512 and size) naming the VERSIONED files. The rolling release
 * publishes the same bytes under fixed names, and the updater downloads
 * exactly the names a feed lists, from the feed's own location (#1129: a feed
 * naming files that are not there makes every update 404). So every `url`,
 * and the top-level `path`, is rewritten to its rolling name. The version and
 * checksums stay as they are, because they describe the same bytes. A name
 * with no rolling copy is refused rather than left pointing at nothing.
 *
 * Line-based on purpose, like verify-update-feed.mjs: the feed is a small,
 * stable electron-builder output, and only these two keys name files. */
export function rollingPreviewFeed(text, renames) {
  return String(text).split('\n').map(line => {
    const match = /^(\s*(?:-\s+)?(?:url|path):\s*)(['"]?)(.+?)\2\s*$/.exec(line)
    if (!match) return line
    const rolling = renames.get(match[3])
    if (!rolling) throw new Error(`The update feed names ${match[3]}, which has no rolling copy.`)
    return `${match[1]}${rolling}`
  }).join('\n')
}

/** Keep each architecture's single versioned dmg and zip (the dated
 * release's assets, named by electron-builder with the preview version), add
 * a copy under the fixed rolling name, and turn electron-builder's feed into
 * `preview-mac.yml` for the rolling release (#1168). Every other yml
 * (builder-debug.yml) and every blockmap is dropped: the Preview channel
 * downloads in full (differential download needs versioned names, see
 * src/shared/updates/updateChannel.ts), and the dated releases are
 * download-only.
 *
 * Refuses rather than guesses when an architecture has zero or several
 * candidates, or when there is not exactly one feed: publishing the wrong
 * binary, or a feed for the wrong files, under a permanent URL is worse than
 * a red run. */
function commandRename(dir) {
  if (!dir) throw new Error('usage: preview.mjs rename <dir>')
  const files = readdirSync(dir)
  const renames = new Map()
  for (const arch of PREVIEW_ARCHES) {
    for (const ext of ['dmg', 'zip']) {
      const rolling = `Agent.Code-preview-${arch}.${ext}`
      const candidates = files.filter(name => name.endsWith(`-${arch}.${ext}`) && name !== rolling)
      if (candidates.length !== 1) {
        throw new Error(`Expected exactly one ${arch} .${ext}, found ${candidates.length}: ${JSON.stringify(candidates)} (all files: ${JSON.stringify(files)})`)
      }
      copyFileSync(join(dir, candidates[0]), join(dir, rolling))
      renames.set(candidates[0], rolling)
    }
  }
  // electron-builder names the feed `latest-mac.yml` even for a preview
  // version (the GitHub publisher never derives a channel from the version),
  // but accept any single `*-mac.yml` so a future electron-builder that does
  // cannot silently drop the feed.
  const feeds = files.filter(name => name.endsWith('-mac.yml') && name !== PREVIEW_FEED_NAME)
  if (feeds.length !== 1) {
    throw new Error(`Expected exactly one update feed (*-mac.yml), found ${feeds.length}: ${JSON.stringify(feeds)}`)
  }
  const feed = rollingPreviewFeed(readFileSync(join(dir, feeds[0]), 'utf8'), renames)
  for (const name of readdirSync(dir)) {
    if (name.endsWith('.blockmap') || name.endsWith('.yml')) rmSync(join(dir, name))
  }
  writeFileSync(join(dir, PREVIEW_FEED_NAME), feed)
  console.log(readdirSync(dir).join('\n'))
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' })
}

function isReachableCommit(sha) {
  if (!SHA.test(sha)) return false
  return spawnSync('git', ['cat-file', '-e', `${sha}^{commit}`]).status === 0
}

/** Three bodies:
 * - preview-dated-body.md for the dated release;
 * - preview-body-publishing.md for the rolling release while it uploads (no
 *   marker);
 * - preview-body.md for the rolling release once every upload succeeded,
 *   with `built-from:` as its first line. Written last, so a failed publish
 *   leaves no marker for this SHA and the next run rebuilds instead of
 *   skipping. */
function commandNotes(outDir) {
  if (!outDir) throw new Error('usage: preview.mjs notes <outDir>')
  const headSha = process.env.HEAD_SHA ?? ''
  const prevSha = process.env.PREV_SHA ?? ''
  const version = process.env.VERSION ?? ''
  const repo = process.env.GITHUB_REPOSITORY ?? ''
  const server = process.env.GITHUB_SERVER_URL ?? 'https://github.com'
  if (!SHA.test(headSha)) throw new Error(`HEAD_SHA is not a 40-hex commit SHA: "${headSha}"`)
  if (!/-preview\./.test(version)) throw new Error(`VERSION is not a preview version: "${version}"`)

  // The previous SHA may not be in this clone: a force-pushed or deleted
  // branch, or a hand-edited body. That used to crash `git log` under set -e
  // after a full build. It is only notes, so fall back to recent history.
  let commits
  if (isReachableCommit(prevSha)) {
    const total = Number(git(['rev-list', '--count', `${prevSha}..${headSha}`]).trim())
    const listed = git(['log', '--oneline', `--max-count=${NOTES_MAX_COMMITS}`, `${prevSha}..${headSha}`]).trimEnd()
    commits = ['### Commits since the previous preview', listed]
    if (total > NOTES_MAX_COMMITS) {
      commits.push('', `_Showing the newest ${NOTES_MAX_COMMITS} of ${total}. Full list: ${server}/${repo}/compare/${prevSha}...${headSha}_`)
    }
  } else {
    commits = ['### Recent commits', '_No reachable previous preview. The last 30 commits:_', git(['log', '--oneline', '-30', headSha]).trimEnd()]
  }

  const tree = `[\`${headSha.slice(0, 12)}\`](${server}/${repo}/tree/${headSha})`
  const next = version.split('-')[0]
  const channel = 'To get previews as updates, choose Settings → Workspace → Update channel → Preview (a preview installed from here starts on Preview). Switching back to Stable waits for the next stable release; it never downgrades.'
  const dated = [
    `Preview of Agent Code ${next}, built from ${tree} on \`main\`, signed and notarized. ${channel}`,
    '',
    ...commits,
    '',
  ].join('\n')
  const rolling = [
    `The newest preview: Agent Code \`${version}\`, built from ${tree}, signed and notarized. Asset names are fixed, so these links always download the latest preview. ${channel} Every preview is also published as its own dated release.`,
    '',
    // Honest about the rolling tag. GitHub's "Source code" archives follow
    // the `preview` TAG, which stays at the first rolling preview's commit,
    // because moving a published tag breaks anyone who pinned it.
    '> The `preview` tag and its "Source code" archives point at the first rolling preview\'s commit. Use the tree link above, or the dated release, for this build\'s source.',
    '',
    ...commits,
    '',
  ].join('\n')

  writeFileSync(join(outDir, 'preview-dated-body.md'), dated)
  writeFileSync(join(outDir, 'preview-body-publishing.md'), `publishing: ${headSha}\n\n${rolling}`)
  writeFileSync(join(outDir, 'preview-body.md'), `built-from: ${headSha}\n\n${rolling}`)
}

/** Delete dated previews past retention, and the retired `nightly` release,
 * together with their tags. Runs after a successful publish, so a failing
 * build never deletes the previews people might fall back to. */
function commandPrune() {
  const repo = process.env.GITHUB_REPOSITORY ?? ''
  if (!repo) throw new Error('GITHUB_REPOSITORY is not set')
  const listed = spawnSync('gh', [
    'api', '--paginate', `repos/${repo}/releases`,
    '--jq', '.[] | {tag: .tag_name, published: .published_at}',
  ], { encoding: 'utf8' })
  if (listed.error) throw listed.error
  if (listed.status !== 0) throw new Error(`gh api failed (exit ${listed.status}): ${listed.stderr.trim()}`)
  const releases = listed.stdout.split('\n').filter(Boolean).map(line => JSON.parse(line))
  const doomed = selectPrunable(releases, { now: now() })
  for (const tag of doomed) {
    const result = spawnSync('gh', ['release', 'delete', tag, '--repo', repo, '--cleanup-tag', '--yes'], { encoding: 'utf8' })
    if (result.status !== 0) throw new Error(`Could not delete release ${tag}: ${result.stderr.trim()}`)
    console.log(`Deleted release ${tag}`)
  }
  if (doomed.length === 0) console.log('No previews past retention.')
}

const commands = { decide: commandDecide, rename: commandRename, notes: commandNotes, prune: commandPrune }

// Run only when executed directly, so the helpers can be imported by the
// tests. Both sides go through realpath: import.meta.url resolves symlinks but
// process.argv[1] does not, so a symlinked checkout made the plain comparison
// false. The script then did NOTHING and exited 0, and a silent `decide`
// looks exactly like a green skip (verification review).
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
    console.error(`usage: preview.mjs <${Object.keys(commands).join('|')}> [arg]`)
    process.exit(2)
  }
  try {
    command(arg)
  } catch (error) {
    console.error(`[preview] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
