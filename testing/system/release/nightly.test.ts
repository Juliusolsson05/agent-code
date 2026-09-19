import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// Imported from the script so the test and the implementation cannot drift
// on the cap. The value itself is asserted through the real process output.
import { NOTES_MAX_COMMITS } from '../../../scripts/release/nightly.mjs'

// System tests for scripts/release/nightly.mjs: the nightly workflow's decision,
// rename and release-notes logic. It used to live inline in
// .github/workflows/nightly.yml, where nothing could exercise it, and the PR
// #1012 review then found real defects in it (a CRLF marker never matching,
// an unreachable previous SHA crashing `git log`, the marker written before
// the uploads).
//
// WHY these are system tests, and where every input comes from
// (staged-decomposition fixture rule: reality, not imagination):
//   - The script runs as a REAL child process, the same way the workflow
//     invokes it. `gh` is the only edge replaced: a stub on PATH replays
//     RECORDED `gh api` output (testing/fixtures/release-nightly, captured
//     2026-09-19; provenance in that folder's README) and records its argv.
//   - Release-notes composition runs against a REAL temporary git repository.
//   - Rename runs on files named exactly like the published v0.0.2-beta.1
//     assets. The names come from the recorded payload, mapped back from
//     GitHub's "Agent.Code" upload spelling to electron-builder's local
//     "Agent Code".
// A few cases need states that do not exist on GitHub yet, such as a complete
// nightly. Those are DERIVED from the recorded beta payload by a named,
// visible transformation in this file, never hand-typed.

const repoRoot = resolve(__dirname, '../../..')
const script = join(repoRoot, 'scripts/release/nightly.mjs')
const fixtures = join(repoRoot, 'testing/fixtures/release-nightly')
// Real commits from this repo's history (#1019's merge, and main just before
// it), so every SHA in these tests is one a run could actually see.
const HEAD = 'cbaf48a5d1da113f4e36097789e9496ce10e3bdf'
const OTHER = 'c3614cb825f7ee1fafb46b0dd704ae6ce1fe90db'

type Release = { body: string | null, assets: { name: string, state: string }[] }
const recordedBeta = (): Release => JSON.parse(readFileSync(join(fixtures, 'gh-release-v0.0.2-beta.1.json'), 'utf8'))
const recordedCrlf = (): Release => JSON.parse(readFileSync(join(fixtures, 'gh-release-react-latest-crlf.json'), 'utf8'))

/** DERIVED: the recorded beta release as a complete nightly. Its four
 * versioned dmg/zip assets are renamed to the fixed nightly names (exactly
 * what the workflow's rename step produces), and the body gets the marker
 * for `sha`. Every other field, including each asset's real `state`, is the
 * recorded payload. */
function asCompleteNightly(release: Release, sha: string, newline = '\n'): Release {
  return {
    ...release,
    body: `built-from: ${sha}${newline}${newline}${release.body ?? ''}`,
    assets: release.assets.map(asset => ({
      ...asset,
      name: asset.name.replace(/^Agent\.Code-[^-]+-[^-]+-(arm64|x64)\.(dmg|zip)$/, 'Agent.Code-nightly-$1.$2'),
    })),
  }
}

const temps: string[] = []
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function temp(prefix: string) { const dir = mkdtempSync(join(tmpdir(), prefix)); temps.push(dir); return dir }

/** Run `decide` with a stub `gh` that replays one recorded response. */
function decide(response: { stdout: string, stderr?: string, exit?: number }, env: Record<string, string> = {}) {
  const dir = temp('nightly-decide-')
  const bin = join(dir, 'bin'); mkdirSync(bin)
  writeFileSync(join(dir, 'stdout'), response.stdout)
  writeFileSync(join(dir, 'stderr'), response.stderr ?? '')
  // The stub is the only replaced edge. It records its argv so the tests can
  // pin WHICH endpoint the script asks for, not just what it does with the answer.
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/argv"\ncat "${dir}/stdout"\ncat "${dir}/stderr" >&2\nexit ${response.exit ?? 0}\n`)
  chmodSync(join(bin, 'gh'), 0o755)
  const output = join(dir, 'github-output'); writeFileSync(output, '')
  const run = spawnSync(process.execPath, [script, 'decide'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_OUTPUT: output, GITHUB_SHA: HEAD, GITHUB_REPOSITORY: 'Juliusolsson05/agent-code', GITHUB_REF_NAME: 'main', FORCE: 'false', ...env },
  })
  const outputs = Object.fromEntries(readFileSync(output, 'utf8').split('\n').filter(Boolean).map(line => line.split(/=(.*)/s).slice(0, 2)))
  const argv = existsSync(join(dir, 'argv')) ? readFileSync(join(dir, 'argv'), 'utf8').trim().split('\n') : []
  return { status: run.status, stderr: run.stderr, stdout: run.stdout, outputs, argv }
}
const recorded = (name: string) => ({
  stdout: readFileSync(join(fixtures, `${name}.stdout`), 'utf8'),
  stderr: readFileSync(join(fixtures, `${name}.stderr`), 'utf8'),
  exit: 1,
})

describe('nightly decide: should this run build?', () => {
  it('builds when no nightly exists yet (recorded 404), and asks for exactly the nightly tag', () => {
    const result = decide(recorded('gh-api-nightly-404'))
    expect(result.status).toBe(0)
    expect(result.argv).toEqual(['api', 'repos/Juliusolsson05/agent-code/releases/tags/nightly'])
    expect(result.outputs).toMatchObject({ changed: 'true', 'head-sha': HEAD, 'prev-sha': '' })
  })

  it('fails loudly on any non-404 API error (recorded 401) instead of rebuilding under a false "first nightly"', () => {
    const result = decide(recorded('gh-api-401'))
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Bad credentials')
    expect(result.outputs.changed).toBeUndefined()
  })

  it('builds when the release has no marker and no nightly assets (the recorded beta payload)', () => {
    const result = decide({ stdout: JSON.stringify(recordedBeta()) })
    expect(result.outputs).toMatchObject({ changed: 'true', 'prev-sha': '' })
  })

  it('skips when this commit already has a complete nightly', () => {
    const result = decide({ stdout: JSON.stringify(asCompleteNightly(recordedBeta(), HEAD)) })
    expect(result.outputs).toMatchObject({ changed: 'false', 'prev-sha': HEAD })
  })

  it('still recognises the marker after a web-UI edit stored the body with CRLF', () => {
    // GitHub stores bodies saved through the web UI with CRLF. The recorded
    // react release body is one of these, so it supplies the real line endings.
    // The old inline `sed 's/^built-from: //'` kept the trailing \r, so the SHA
    // never equalled HEAD: every night rebuilt and then crashed in `git log`.
    const crlfBody = recordedCrlf().body ?? ''
    expect(crlfBody).toContain('\r\n')
    const release = { ...asCompleteNightly(recordedBeta(), HEAD, '\r\n'), body: `built-from: ${HEAD}\r\n\r\n${crlfBody}` }
    expect(decide({ stdout: JSON.stringify(release) }).outputs).toMatchObject({ changed: 'false', 'prev-sha': HEAD })
  })

  it('rebuilds when the marker matches but an asset is missing (a publish that failed midway)', () => {
    const release = asCompleteNightly(recordedBeta(), HEAD)
    release.assets = release.assets.filter(asset => asset.name !== 'Agent.Code-nightly-x64.dmg')
    const result = decide({ stdout: JSON.stringify(release) })
    expect(result.outputs.changed).toBe('true')
    expect(result.stdout + result.stderr).toContain('Agent.Code-nightly-x64.dmg')
  })

  it('rebuilds when an asset exists but never finished uploading (state "open")', () => {
    const release = asCompleteNightly(recordedBeta(), HEAD)
    release.assets = release.assets.map(asset => asset.name === 'Agent.Code-nightly-arm64.zip' ? { ...asset, state: 'open' } : asset)
    expect(decide({ stdout: JSON.stringify(release) }).outputs.changed).toBe('true')
  })

  it('builds when main moved past the last nightly, and reports the previous SHA for the notes', () => {
    const result = decide({ stdout: JSON.stringify(asCompleteNightly(recordedBeta(), OTHER)) })
    expect(result.outputs).toMatchObject({ changed: 'true', 'prev-sha': OTHER, 'head-sha': HEAD })
  })

  it('treats anything but an exact 40-hex SHA as no marker (e.g. an abbreviated SHA pasted by hand)', () => {
    // Verification review: loosening the parse to /^built-from: (\S+)/ kept
    // every other case green. A short SHA can never equal GITHUB_SHA, so it
    // must mean "no trustworthy marker", which rebuilds, rather than be
    // reported as a previous SHA that the notes would then try to range from.
    const release = asCompleteNightly(recordedBeta(), HEAD)
    release.body = `built-from: ${HEAD.slice(0, 8)}\n\n${recordedBeta().body ?? ''}`
    expect(decide({ stdout: JSON.stringify(release) }).outputs).toMatchObject({ changed: 'true', 'prev-sha': '' })
  })

  it('force rebuilds even a complete nightly for this commit', () => {
    const result = decide({ stdout: JSON.stringify(asCompleteNightly(recordedBeta(), HEAD)) }, { FORCE: 'true' })
    expect(result.outputs.changed).toBe('true')
  })
})

describe('nightly rename: versioned artifacts to fixed names', () => {
  /** A release/ folder named exactly like the real beta artifacts, as
   * electron-builder writes them locally (GitHub's "Agent.Code" upload
   * spelling mapped back to "Agent Code"). Each file's content is its original
   * name, so the test can prove which file went where. */
  function seedFromRecordedBeta(filter: (name: string) => boolean = () => true) {
    const dir = temp('nightly-rename-')
    for (const { name } of recordedBeta().assets) {
      const local = name.replace(/^Agent\.Code-/, 'Agent Code-')
      if (filter(local)) writeFileSync(join(dir, local), local)
    }
    return dir
  }
  const rename = (dir: string) => spawnSync(process.execPath, [script, 'rename', dir], { encoding: 'utf8' })

  it('maps each architecture\'s dmg and zip onto the fixed names and drops the updater metadata', () => {
    const dir = seedFromRecordedBeta()
    const result = rename(dir)
    expect(result.status).toBe(0)
    for (const arch of ['arm64', 'x64']) {
      for (const ext of ['dmg', 'zip']) {
        expect(readFileSync(join(dir, `Agent.Code-nightly-${arch}.${ext}`), 'utf8')).toBe(`Agent Code-0.0.2-beta.1-${arch}.${ext}`)
      }
    }
    const left = readdirSync(dir)
    expect(left.filter(name => name.endsWith('.blockmap') || name === 'latest-mac.yml')).toEqual([])
  })

  it('refuses when an architecture is missing, naming what it found', () => {
    const dir = seedFromRecordedBeta(name => name !== 'Agent Code-0.0.2-beta.1-x64.zip')
    const result = rename(dir)
    expect(result.status).not.toBe(0)
    // Name the missing kind precisely. The error also lists every file, and
    // that list contains x64 names, so a bare /x64/ would pass even if the
    // wrong architecture were reported.
    expect(result.stderr).toMatch(/Expected exactly one x64 \.zip, found 0/)
  })

  it('refuses when an architecture has two candidate dmgs rather than guessing', () => {
    const dir = seedFromRecordedBeta()
    writeFileSync(join(dir, 'Agent Code-0.0.3-arm64.dmg'), 'second')
    expect(rename(dir).status).not.toBe(0)
  })
})

describe('nightly notes: release bodies from a real git history', () => {
  function gitRepo() {
    const dir = temp('nightly-notes-')
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
    const out = temp('nightly-notes-out-')
    const result = spawnSync(process.execPath, [script, 'notes', out], {
      cwd, encoding: 'utf8',
      env: { ...process.env, HEAD_SHA: head, PREV_SHA: prev, GITHUB_REPOSITORY: 'Juliusolsson05/agent-code', GITHUB_SERVER_URL: 'https://github.com' },
    })
    const read = (name: string) => existsSync(join(out, name)) ? readFileSync(join(out, name), 'utf8') : ''
    return { status: result.status, stderr: result.stderr, publishing: read('nightly-body-publishing.md'), final: read('nightly-body.md') }
  }

  it('lists exactly the commits since the previous nightly', () => {
    const { dir, shas } = gitRepo()
    const result = notes(dir, shas[2], shas[0])
    expect(result.status).toBe(0)
    expect(result.final).toContain('fix: second')
    expect(result.final).toContain('docs: third')
    expect(result.final).not.toContain('feat: first')
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
    expect(result.final).toContain('No reachable previous nightly')
    expect(result.final).toContain('feat: first')
  })

  it('caps the commit list and links the full comparison, so a long gap cannot overflow the release body', () => {
    // GitHub rejects release bodies over 125,000 characters. This repo lands
    // about 1,100 commits a month at about 77 characters each, so a few weeks
    // of failed nightlies would overflow, and `gh release edit` would then
    // fail after a full build (verification review).
    const { dir, shas } = gitRepo()
    for (let i = 0; i < NOTES_MAX_COMMITS + 5; i++) execFileSync('git', ['commit', '-q', '--allow-empty', '-m', `chore: filler ${i}`], { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
    const result = notes(dir, head, shas[0])
    expect(result.status).toBe(0)
    const listed = result.final.split('\n').filter(line => /^[0-9a-f]{7,} /.test(line))
    expect(listed).toHaveLength(NOTES_MAX_COMMITS)
    expect(result.final).toContain(`https://github.com/Juliusolsson05/agent-code/compare/${shas[0]}...${head}`)
  })

  it('falls back to recent history on the first nightly (no previous SHA)', () => {
    const { dir, shas } = gitRepo()
    const result = notes(dir, shas[2], '')
    expect(result.status).toBe(0)
    expect(result.final).toContain('No reachable previous nightly')
  })
})
