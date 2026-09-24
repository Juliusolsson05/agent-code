import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// Imported from the script so the test and the implementation cannot drift
// on the caps. The behaviour itself is asserted through the real process.
import { NOTES_MAX_COMMITS, PREVIEW_KEEP_DAYS, PREVIEW_KEEP_MIN, datedCollision, previewVersion, selectPrunable } from '../../../scripts/release/preview.mjs'

// System tests for scripts/release/preview.mjs: the preview workflow's
// version, decision, rename, release-notes and prune logic
// (.github/workflows/preview.yml, formerly the rolling nightly of #1011).
//
// WHY these are system tests, and where every input comes from
// (staged-decomposition fixture rule: reality, not imagination):
//   - The script runs as a REAL child process, the same way the workflow
//     invokes it. `gh` is the only edge replaced: a stub on PATH replays
//     RECORDED `gh api` output (testing/fixtures/release-preview; provenance
//     in that folder's README) and records its argv.
//   - Release-notes composition runs against a REAL temporary git repository.
//   - Rename runs on files named exactly like the published v0.0.2-beta.1
//     assets, spelled the way electron-builder writes them since #1129.
//   - The complete rolling release is the REAL `nightly` release recorded on
//     2026-09-24 (built from 7feda947, all four assets uploaded), with its
//     asset names mapped onto the preview names by `asRollingPreview` — the
//     only difference between the two workflows' rolling releases.

const repoRoot = resolve(__dirname, '../../..')
const script = join(repoRoot, 'scripts/release/preview.mjs')
const fixtures = join(repoRoot, 'testing/fixtures/release-preview')
// Real commits from this repo's history (#1019's merge, and main just before
// it), so every SHA in these tests is one a run could actually see.
const HEAD = 'cbaf48a5d1da113f4e36097789e9496ce10e3bdf'
const OTHER = 'c3614cb825f7ee1fafb46b0dd704ae6ce1fe90db'
// The SHA the recorded nightly was built from.
const RECORDED_NIGHTLY_SHA = '7feda94767c6c921c05aa75169c55c9a5728bf38'

type Release = { body: string | null, assets: { name: string, state: string }[] }
const recordedBeta = (): Release => JSON.parse(readFileSync(join(fixtures, 'gh-release-v0.0.2-beta.1.json'), 'utf8'))
const recordedCrlf = (): Release => JSON.parse(readFileSync(join(fixtures, 'gh-release-react-latest-crlf.json'), 'utf8'))
const recordedNightly = (): Release => JSON.parse(readFileSync(join(fixtures, 'gh-release-nightly-complete.json'), 'utf8'))
const recordedReleases = () => readFileSync(join(fixtures, 'gh-api-releases-list.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map(line => JSON.parse(line) as { tag: string, published: string })

/** DERIVED: the recorded complete `nightly` release as the rolling preview.
 * Two differences, both visible here: the fixed asset names, and the
 * preview feed (#1168), modelled on the recorded arm64 zip asset (same
 * uploader and state) since the nightly never published one. */
function asRollingPreview(release: Release, sha = RECORDED_NIGHTLY_SHA, newline = '\n'): Release {
  const body = (release.body ?? '').replace(/^built-from: [0-9a-f]{40}\r?\n/, '')
  const assets = release.assets.map(asset => ({ ...asset, name: asset.name.replace('Agent.Code-nightly-', 'Agent.Code-preview-') }))
  const zip = assets.find(asset => asset.name === 'Agent.Code-preview-arm64.zip')!
  return {
    ...release,
    body: `built-from: ${sha}${newline}${body}`,
    assets: [...assets, { ...zip, name: 'preview-mac.yml' }],
  }
}

const temps: string[] = []
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function temp(prefix: string) { const dir = mkdtempSync(join(tmpdir(), prefix)); temps.push(dir); return dir }

type GhResponse = { stdout: string, stderr?: string, exit?: number }
const recorded = (name: string) => ({
  stdout: readFileSync(join(fixtures, `${name}.stdout`), 'utf8'),
  stderr: readFileSync(join(fixtures, `${name}.stderr`), 'utf8'),
  exit: 1,
})

/** A stub `gh` on PATH, the only replaced edge. It appends every argv it
 * receives (one call per line) to `calls`. A lookup of a DATED preview tag
 * (`releases/tags/v…`) replays `dated` (the recorded 404 unless a test says
 * otherwise); `release delete` succeeds silently like the real CLI; every
 * other call replays `response`. */
function stubGh(response: GhResponse, dated: GhResponse = recorded('gh-api-nightly-404')) {
  const dir = temp('preview-gh-')
  const bin = join(dir, 'bin'); mkdirSync(bin)
  for (const [name, value] of [['default', response], ['dated', dated]] as const) {
    writeFileSync(join(dir, `${name}.stdout`), value.stdout)
    writeFileSync(join(dir, `${name}.stderr`), value.stderr ?? '')
    writeFileSync(join(dir, `${name}.exit`), String(value.exit ?? 0))
  }
  writeFileSync(join(dir, 'calls'), '')
  writeFileSync(join(bin, 'gh'), [
    '#!/bin/sh',
    `echo "$*" >> "${dir}/calls"`,
    'if [ "$1" = release ]; then exit 0; fi',
    'which=default',
    'case "$2" in */releases/tags/v*) which=dated;; esac',
    `cat "${dir}/$which.stdout"`,
    `cat "${dir}/$which.stderr" >&2`,
    `exit $(cat "${dir}/$which.exit")`,
    '',
  ].join('\n'))
  chmodSync(join(bin, 'gh'), 0o755)
  const calls = () => readFileSync(join(dir, 'calls'), 'utf8').split('\n').filter(Boolean)
  return { path: `${bin}:${process.env.PATH}`, calls }
}

/** Run `decide` in a checkout whose package.json is the current stable (0.1.3). */
function decide(response: GhResponse, env: Record<string, string> = {}, dated?: GhResponse) {
  const gh = stubGh(response, dated)
  const cwd = temp('preview-decide-')
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'agent-code', version: '0.1.3' }))
  const output = join(cwd, 'github-output'); writeFileSync(output, '')
  const run = spawnSync(process.execPath, [script, 'decide'], {
    cwd, encoding: 'utf8',
    env: {
      ...process.env, PATH: gh.path, GITHUB_OUTPUT: output, GITHUB_SHA: HEAD,
      GITHUB_REPOSITORY: 'Juliusolsson05/agent-code', GITHUB_REF_NAME: 'main', GITHUB_REF: 'refs/heads/main',
      GITHUB_EVENT_NAME: 'schedule', FORCE: 'false', NOW: '2026-09-24T09:46:43Z', ...env,
    },
  })
  const outputs = Object.fromEntries(readFileSync(output, 'utf8').split('\n').filter(Boolean).map(line => line.split(/=(.*)/s).slice(0, 2)))
  return { status: run.status, stderr: run.stderr, stdout: run.stdout, outputs, calls: gh.calls() }
}

describe('preview version', () => {
  // The real clock of today's scheduled run (09:46 UTC; the cron says 05:00
  // but GitHub starts it about 4.5 hours late).
  const now = new Date('2026-09-24T09:46:43Z')

  it('previews the next PATCH of the stable version, dated by UTC day', () => {
    expect(previewVersion({ stableVersion: '0.1.3', now, dispatched: false })).toBe('0.1.4-preview.20260924')
  })

  it('a manual run adds the UTC time so it never collides with that night\'s tag', () => {
    // 09:46 → 946: semver forbids leading zeros in numeric identifiers, and
    // numeric comparison still orders 946 before 1415.
    expect(previewVersion({ stableVersion: '0.1.3', now, dispatched: true })).toBe('0.1.4-preview.20260924.946')
  })

  it('can target the next MINOR while a minor release is being prepared', () => {
    expect(previewVersion({ stableVersion: '0.1.3', target: 'minor', now, dispatched: true })).toBe('0.2.0-preview.20260924.946')
  })

  it('patch numbers go past 9', () => {
    expect(previewVersion({ stableVersion: '0.1.9', now, dispatched: false })).toBe('0.1.10-preview.20260924')
  })

  it('a prerelease left in package.json previews its own core instead of skipping a version', () => {
    expect(previewVersion({ stableVersion: '0.0.2-beta.1', now, dispatched: false })).toBe('0.0.2-preview.20260924')
  })

  it('refuses a version that is not MAJOR.MINOR.PATCH, and an unknown target', () => {
    expect(() => previewVersion({ stableVersion: '1.1', now, dispatched: false })).toThrow(/MAJOR\.MINOR\.PATCH/)
    expect(() => previewVersion({ stableVersion: '0.1.3', target: 'major', now, dispatched: false })).toThrow(/patch or minor/)
  })
})

describe('preview decide: should this run build, and as which version?', () => {
  it('builds when no rolling preview exists yet (recorded 404), asking for exactly the preview tag', () => {
    const result = decide(recorded('gh-api-nightly-404'))
    expect(result.status).toBe(0)
    // The rolling release, then the dated tag it is about to create.
    expect(result.calls).toEqual([
      'api repos/Juliusolsson05/agent-code/releases/tags/preview',
      'api repos/Juliusolsson05/agent-code/releases/tags/v0.1.4-preview.20260924',
    ])
    expect(result.outputs).toMatchObject({
      changed: 'true', 'head-sha': HEAD, 'prev-sha': '',
      version: '0.1.4-preview.20260924', tag: 'v0.1.4-preview.20260924',
    })
  })

  it('a dispatched minor run gets a minor, time-stamped version', () => {
    const result = decide(recorded('gh-api-nightly-404'), { GITHUB_EVENT_NAME: 'workflow_dispatch', TARGET: 'minor' })
    expect(result.outputs).toMatchObject({ version: '0.2.0-preview.20260924.946', tag: 'v0.2.0-preview.20260924.946' })
  })

  it('fails loudly on any non-404 API error (recorded 401) instead of rebuilding under a false "first preview"', () => {
    const result = decide(recorded('gh-api-401'))
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Bad credentials')
    expect(result.outputs.changed).toBeUndefined()
  })

  it('builds when the release has no marker and no preview assets (the recorded beta payload)', () => {
    expect(decide({ stdout: JSON.stringify(recordedBeta()) }).outputs).toMatchObject({ changed: 'true', 'prev-sha': '' })
  })

  it('skips when this commit already has a complete rolling preview (the recorded nightly, as the preview)', () => {
    const result = decide({ stdout: JSON.stringify(asRollingPreview(recordedNightly(), HEAD)) })
    expect(result.outputs).toMatchObject({ changed: 'false', 'prev-sha': HEAD })
  })

  it('rebuilds a rolling preview that has its binaries but no update feed', () => {
    // A preview without preview-mac.yml downloads fine by hand but updates
    // nobody on the Preview channel (#1168).
    const release = asRollingPreview(recordedNightly(), HEAD)
    release.assets = release.assets.filter(asset => asset.name !== 'preview-mac.yml')
    const result = decide({ stdout: JSON.stringify(release) })
    expect(result.outputs.changed).toBe('true')
    expect(result.stdout).toContain('preview-mac.yml')
  })

  it('does NOT take the old nightly\'s assets as a complete preview', () => {
    // The recorded release unchanged: marker for this SHA, but nightly asset
    // names. The first preview run must build rather than skip.
    const release = { ...recordedNightly(), body: `built-from: ${HEAD}\n\n` }
    expect(decide({ stdout: JSON.stringify(release) }).outputs.changed).toBe('true')
  })

  it('still recognises the marker after a web-UI edit stored the body with CRLF', () => {
    const crlfBody = recordedCrlf().body ?? ''
    expect(crlfBody).toContain('\r\n')
    const release = { ...asRollingPreview(recordedNightly(), HEAD, '\r\n'), body: `built-from: ${HEAD}\r\n\r\n${crlfBody}` }
    expect(decide({ stdout: JSON.stringify(release) }).outputs).toMatchObject({ changed: 'false', 'prev-sha': HEAD })
  })

  it('rebuilds when the marker matches but an asset is missing (a publish that failed midway)', () => {
    const release = asRollingPreview(recordedNightly(), HEAD)
    release.assets = release.assets.filter(asset => asset.name !== 'Agent.Code-preview-x64.dmg')
    const result = decide({ stdout: JSON.stringify(release) })
    expect(result.outputs.changed).toBe('true')
    expect(result.stdout + result.stderr).toContain('Agent.Code-preview-x64.dmg')
  })

  it('rebuilds when an asset exists but never finished uploading (state "open")', () => {
    const release = asRollingPreview(recordedNightly(), HEAD)
    release.assets = release.assets.map(asset => asset.name === 'Agent.Code-preview-arm64.zip' ? { ...asset, state: 'open' } : asset)
    expect(decide({ stdout: JSON.stringify(release) }).outputs.changed).toBe('true')
  })

  it('builds when main moved past the last preview, and reports the previous SHA for the notes', () => {
    const result = decide({ stdout: JSON.stringify(asRollingPreview(recordedNightly(), OTHER)) })
    expect(result.outputs).toMatchObject({ changed: 'true', 'prev-sha': OTHER, 'head-sha': HEAD })
  })

  it('treats anything but an exact 40-hex SHA as no marker (e.g. an abbreviated SHA pasted by hand)', () => {
    const release = asRollingPreview(recordedNightly(), HEAD)
    release.body = `built-from: ${HEAD.slice(0, 8)}\n\n`
    expect(decide({ stdout: JSON.stringify(release) }).outputs).toMatchObject({ changed: 'true', 'prev-sha': '' })
  })

  it('a target=minor dispatch builds even when main has not moved (it asks for a different label)', () => {
    const result = decide({ stdout: JSON.stringify(asRollingPreview(recordedNightly(), HEAD)) }, { GITHUB_EVENT_NAME: 'workflow_dispatch', TARGET: 'minor' })
    expect(result.outputs).toMatchObject({ changed: 'true', version: '0.2.0-preview.20260924.946' })
  })

  it('refuses to overwrite a dated preview built from another commit (Re-run all jobs on an older run)', () => {
    // DERIVED from the recorded nightly: a real release whose
    // target_commitish holds the SHA it was built from (7feda947), exactly as
    // the dated preview's publish step creates it. Here it is today's dated
    // preview, and this run (a re-run of yesterday's) is for another commit.
    const todaysDated = { ...recordedNightly(), tag_name: 'v0.1.4-preview.20260924' }
    const result = decide(recorded('gh-api-nightly-404'), {}, { stdout: JSON.stringify(todaysDated) })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/v0\.1\.4-preview\.20260924 already exists for commit 7feda94767c6/)
    expect(result.outputs.changed).toBeUndefined()
  })

  it('allows a genuine retry of the same commit over its own dated preview', () => {
    const sameCommit = { ...recordedNightly(), target_commitish: HEAD }
    expect(decide(recorded('gh-api-nightly-404'), {}, { stdout: JSON.stringify(sameCommit) }).outputs.changed).toBe('true')
  })

  it('refuses a dispatch from any branch but main', () => {
    const result = decide(recorded('gh-api-nightly-404'), { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/feat/x' })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/main only.*refs\/heads\/feat\/x/)
    expect(result.calls).toEqual([])
  })

  it('force rebuilds even a complete preview for this commit', () => {
    const result = decide({ stdout: JSON.stringify(asRollingPreview(recordedNightly(), HEAD)) }, { FORCE: 'true' })
    expect(result.outputs.changed).toBe('true')
  })
})

describe('preview rename: dated assets, rolling copies and the preview feed', () => {
  const recordedFeed = () => readFileSync(join(fixtures, 'latest-mac-v0.1.3.yml'), 'utf8')
  const feedNames = (text: string) => text.split('\n')
    .map(line => /^\s*(?:-\s+)?(?:url|path):\s*(.+?)\s*$/.exec(line)?.[1])
    .filter((name): name is string => Boolean(name))

  /** A release/ folder exactly as package-macos leaves it for v0.1.3: the
   * REAL electron-builder feed, every file it names, a blockmap per file and
   * builder-debug.yml (all in the recorded v0.1.3 and beta payloads). Each
   * binary's content is its own name, so the test can prove which file went
   * where. */
  function seedFromRecordedFeed(filter: (name: string) => boolean = () => true) {
    const dir = temp('preview-rename-')
    writeFileSync(join(dir, 'latest-mac.yml'), recordedFeed())
    writeFileSync(join(dir, 'builder-debug.yml'), 'x64: {}\n')
    for (const name of new Set(feedNames(recordedFeed()))) {
      if (!filter(name)) continue
      writeFileSync(join(dir, name), name)
      writeFileSync(join(dir, `${name}.blockmap`), `${name}.blockmap`)
    }
    return dir
  }
  const rename = (dir: string) => spawnSync(process.execPath, [script, 'rename', dir], { encoding: 'utf8' })
  const verify = (dir: string) => spawnSync(process.execPath, [join(repoRoot, 'scripts/release/verify-update-feed.mjs'), dir, 'preview-mac.yml'], { encoding: 'utf8' })

  it('keeps the versioned files for the dated release and copies them to the rolling names', () => {
    const dir = seedFromRecordedFeed()
    expect(rename(dir).status).toBe(0)
    for (const arch of ['arm64', 'x64']) {
      for (const ext of ['dmg', 'zip']) {
        const versioned = `Agent-Code-0.1.3-${arch}.${ext}`
        expect(readFileSync(join(dir, versioned), 'utf8')).toBe(versioned)
        expect(readFileSync(join(dir, `Agent.Code-preview-${arch}.${ext}`), 'utf8')).toBe(versioned)
      }
    }
    // Blockmaps (differential download cannot work with fixed names) and
    // every other yml are gone; only the preview feed remains.
    expect(readdirSync(dir).filter(name => name.endsWith('.blockmap'))).toEqual([])
    expect(readdirSync(dir).filter(name => name.endsWith('.yml'))).toEqual(['preview-mac.yml'])
  })

  it('writes preview-mac.yml naming the rolling copies, with the recorded version and checksums untouched', () => {
    const dir = seedFromRecordedFeed()
    expect(rename(dir).status).toBe(0)
    const feed = readFileSync(join(dir, 'preview-mac.yml'), 'utf8')
    expect(new Set(feedNames(feed))).toEqual(new Set([
      'Agent.Code-preview-x64.zip', 'Agent.Code-preview-arm64.zip',
      'Agent.Code-preview-x64.dmg', 'Agent.Code-preview-arm64.dmg',
    ]))
    // Only the file names changed: every other line is the recorded feed's.
    const strip = (text: string) => text.split('\n').filter(line => !/(?:url|path):/.test(line))
    expect(strip(feed)).toEqual(strip(recordedFeed()))
    expect(feed).toContain('version: 0.1.3')
    // And the #1129 verifier accepts it against the files being published.
    const verified = verify(dir)
    expect(verified.status).toBe(0)
    expect(verified.stdout).toContain('OK')
  })

  it('the verifier rejects a preview feed naming a file that is not there', () => {
    const dir = seedFromRecordedFeed()
    expect(rename(dir).status).toBe(0)
    rmSync(join(dir, 'Agent.Code-preview-arm64.zip'))
    const verified = verify(dir)
    expect(verified.status).toBe(1)
    expect(verified.stderr).toMatch(/preview-mac\.yml names files that are not in .*Agent\.Code-preview-arm64\.zip/s)
  })

  it('refuses when the feed names a file with no rolling copy', () => {
    const dir = seedFromRecordedFeed()
    const feed = recordedFeed().replace('path: Agent-Code-0.1.3-x64.zip', 'path: Agent-Code-0.1.3-universal.zip')
    writeFileSync(join(dir, 'latest-mac.yml'), feed)
    const result = rename(dir)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Agent-Code-0.1.3-universal.zip, which has no rolling copy')
  })

  it('refuses when there is no update feed at all', () => {
    const dir = seedFromRecordedFeed()
    rmSync(join(dir, 'latest-mac.yml'))
    expect(rename(dir).stderr).toMatch(/exactly one update feed/)
  })

  it('refuses when an architecture is missing, naming what it found', () => {
    const dir = seedFromRecordedFeed(name => name !== 'Agent-Code-0.1.3-x64.zip')
    const result = rename(dir)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/Expected exactly one x64 \.zip, found 0/)
  })

  it('refuses when an architecture has two candidate dmgs rather than guessing', () => {
    const dir = seedFromRecordedFeed()
    writeFileSync(join(dir, 'Agent-Code-0.0.3-arm64.dmg'), 'second')
    expect(rename(dir).status).not.toBe(0)
  })
})

describe('preview prune: retention over the real release list', () => {
  /** DERIVED: the recorded release list (v0.1.3 … beta-0.0.1, and the
   * `nightly` release) plus dated previews every day for `days` days up to
   * the recorded list's newest date, exactly as preview.yml would create them. */
  function withPreviews(days: number) {
    const previews = Array.from({ length: days }, (_, index) => {
      const date = new Date(Date.UTC(2026, 8, 24 - index, 10, 23))
      const stamp = date.toISOString().slice(0, 10).replaceAll('-', '')
      return { tag: `v0.1.4-preview.${stamp}`, published: date.toISOString() }
    })
    return [...previews, ...recordedReleases()]
  }
  const now = new Date('2026-09-24T10:24:00Z')

  it('never selects a stable, a hand-cut beta or anything not shaped like a preview', () => {
    const doomed = selectPrunable(recordedReleases(), { now })
    expect(doomed).toEqual(['nightly'])
  })

  it('deletes dated previews older than the retention window and the retired nightly', () => {
    const doomed = selectPrunable(withPreviews(20), { now })
    expect(doomed).toContain('nightly')
    const previews = doomed.filter(tag => tag !== 'nightly')
    // Created 10:23 on each of the last 20 days; the cutoff is KEEP_DAYS
    // before 10:24 today, so the preview from exactly KEEP_DAYS ago (10:23)
    // is just past it: days KEEP_DAYS … 19 ago are expired.
    expect(previews).toHaveLength(20 - PREVIEW_KEEP_DAYS)
    expect(previews).not.toContain('v0.1.4-preview.20260924')
    expect(previews.every(tag => /^v0\.1\.4-preview\.\d{8}$/.test(tag))).toBe(true)
  })

  it('always keeps the newest previews even when all are old (a quiet fortnight)', () => {
    const old = withPreviews(5).map(release => /-preview\./.test(release.tag)
      ? { ...release, published: new Date(Date.parse(release.published) - 60 * 24 * 60 * 60 * 1000).toISOString() }
      : release)
    const doomed = selectPrunable(old, { now }).filter(tag => tag !== 'nightly')
    expect(doomed).toHaveLength(5 - PREVIEW_KEEP_MIN)
  })

  it('ages previews by publication, not by the commit date GitHub reports as created_at', () => {
    // A preview of an old commit, published a minute ago, must survive even
    // with more than KEEP_MIN newer-commit previews around (review round 1).
    const releases = [
      ...withPreviews(PREVIEW_KEEP_MIN + 2),
      { tag: 'v0.1.4-preview.20260801', published: '2026-09-24T10:23:00Z' },
    ]
    expect(selectPrunable(releases, { now })).not.toContain('v0.1.4-preview.20260801')
  })

  it('never selects a release without a valid publication time (a draft)', () => {
    const releases = [...withPreviews(PREVIEW_KEEP_MIN), { tag: 'v0.1.4-preview.20250101', published: null as unknown as string }]
    expect(selectPrunable(releases, { now })).not.toContain('v0.1.4-preview.20250101')
  })

  it('runs `gh release delete --cleanup-tag` for exactly the selected tags', () => {
    const list = withPreviews(PREVIEW_KEEP_DAYS + 3).map(release => JSON.stringify(release)).join('\n')
    const gh = stubGh({ stdout: `${list}\n` })
    const result = spawnSync(process.execPath, [script, 'prune'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: gh.path, GITHUB_REPOSITORY: 'Juliusolsson05/agent-code', NOW: now.toISOString() },
    })
    expect(result.status).toBe(0)
    const deletes = gh.calls().filter(call => call.startsWith('release delete'))
    expect(deletes).toContain('release delete nightly --repo Juliusolsson05/agent-code --cleanup-tag --yes')
    expect(deletes.some(call => call.includes('v0.1.3 '))).toBe(false)
    expect(deletes.length).toBeGreaterThan(1)
  })
})

describe('preview notes: release bodies from a real git history', () => {
  function gitRepo() {
    const dir = temp('preview-notes-')
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim()
    git('init', '-q', '-b', 'main')
    const shas: string[] = []
    for (const subject of ['feat: first', 'fix: second', 'docs: third']) {
      git('commit', '-q', '--allow-empty', '-m', subject)
      shas.push(git('rev-parse', 'HEAD'))
    }
    return { dir, shas }
  }
  function notes(cwd: string, head: string, prev: string) {
    const out = temp('preview-notes-out-')
    const result = spawnSync(process.execPath, [script, 'notes', out], {
      cwd, encoding: 'utf8',
      env: { ...process.env, HEAD_SHA: head, PREV_SHA: prev, VERSION: '0.1.4-preview.20260924', GITHUB_REPOSITORY: 'Juliusolsson05/agent-code', GITHUB_SERVER_URL: 'https://github.com' },
    })
    const read = (name: string) => existsSync(join(out, name)) ? readFileSync(join(out, name), 'utf8') : ''
    return { status: result.status, stderr: result.stderr, publishing: read('preview-body-publishing.md'), final: read('preview-body.md'), dated: read('preview-dated-body.md') }
  }

  it('lists exactly the commits since the previous preview, in both the dated and rolling bodies', () => {
    const { dir, shas } = gitRepo()
    const result = notes(dir, shas[2], shas[0])
    expect(result.status).toBe(0)
    expect(result.final).toContain('fix: second')
    expect(result.final).toContain('docs: third')
    expect(result.final).not.toContain('feat: first')
    expect(result.dated).toContain('fix: second')
    expect(result.dated).not.toContain('feat: first')
    // The dated body names the version it previews and says it is never
    // offered by the updater; it carries no skip marker.
    expect(result.dated).toMatch(/^Preview of Agent Code 0\.1\.4,/)
    expect(result.dated).toContain('never offered by the in-app updater')
    expect(result.dated).not.toMatch(/^built-from:/m)
  })

  it('writes the built-from marker ONLY into the final body, as its first line', () => {
    // The publish step posts the "publishing" body; the marker lands only after
    // every asset uploaded. A marker in the publishing body would let a failed
    // upload be skipped forever.
    const { dir, shas } = gitRepo()
    const result = notes(dir, shas[2], shas[0])
    expect(result.final.split('\n')[0]).toBe(`built-from: ${shas[2]}`)
    expect(result.publishing).not.toMatch(/^built-from:/m)
    expect(result.final).toContain(`https://github.com/Juliusolsson05/agent-code/tree/${shas[2]}`)
  })

  it('falls back to recent history when the previous SHA is not in this clone (force-pushed or deleted branch)', () => {
    const { dir, shas } = gitRepo()
    const unreachable = 'deadbeef'.repeat(5)
    const result = notes(dir, shas[2], unreachable)
    expect(result.status).toBe(0)
    expect(result.final).toContain('No reachable previous preview')
    expect(result.final).toContain('feat: first')
  })

  it('caps the commit list and links the full comparison, so a long gap cannot overflow the release body', () => {
    // GitHub rejects release bodies over 125,000 characters. This repo lands
    // about 1,100 commits a month at about 77 characters each, so a few weeks
    // of failed nightlies would overflow, and `gh release edit` would then
    // fail after a full build (verification review).
    const { dir, shas } = gitRepo()
    // The filler history is written by ONE `git fast-import`, not by
    // NOTES_MAX_COMMITS + 5 separate `git commit` processes. Spawning 205 git
    // processes took over 5 s on the macOS runner and timed this test out in
    // the nightly's integration step (run 35428680412), while the notes step
    // under test ran in milliseconds. The history is the same kind of history
    // a real clone has (a linear chain of commits on main), just built in one
    // process. Raising the timeout would have hidden the next slow setup.
    const tip = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
    const stream = Array.from({ length: NOTES_MAX_COMMITS + 5 }, (_, i) => {
      const message = `chore: filler ${i}`
      // Increasing committer dates keep `git log` order identical to the
      // chain order, as consecutive real commits have.
      return [
        'commit refs/heads/main',
        `committer t <t@t> ${1_700_000_000 + i} +0000`,
        `data ${Buffer.byteLength(message)}`,
        message,
        ...(i === 0 ? [`from ${tip}`] : []),
        '',
      ].join('\n')
    }).join('\n')
    execFileSync('git', ['fast-import', '--quiet'], { cwd: dir, input: stream })
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
    expect(execFileSync('git', ['rev-list', '--count', `${shas[0]}..${head}`], { cwd: dir, encoding: 'utf8' }).trim()).toBe(String(NOTES_MAX_COMMITS + 7))
    const result = notes(dir, head, shas[0])
    expect(result.status).toBe(0)
    const listed = result.final.split('\n').filter(line => /^[0-9a-f]{7,} /.test(line))
    expect(listed).toHaveLength(NOTES_MAX_COMMITS)
    expect(result.final).toContain(`https://github.com/Juliusolsson05/agent-code/compare/${shas[0]}...${head}`)
  })

  it('falls back to recent history on the first preview (no previous SHA)', () => {
    const { dir, shas } = gitRepo()
    const result = notes(dir, shas[2], '')
    expect(result.status).toBe(0)
    expect(result.final).toContain('No reachable previous preview')
  })
})
