import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// System tests for scripts/release/identity.mjs: which tag, name and release
// flags a manual release dispatch publishes (release.yml, validate-release).
//
// WHY these rules are tested at all: they decide whether a signed build
// becomes `releases/latest`, the file the landing page's download button, the
// in-app updater and every "latest" link resolve to.
//
// Since 2026-09-24 every manual release is stable (RELEASE.md, "Channels");
// previews of the next version come from preview.yml. The tests therefore pin
// that a manual dispatch can ONLY produce a stable, latest release, and that
// a prerelease version is refused before anything builds.
//
// The script runs as a REAL child process with the env and GITHUB_OUTPUT file
// the workflow gives it. The versions are real: `0.1.3` is the current stable
// (gh release list, 2026-09-24) and `0.0.2-beta.1` the last hand-cut beta.

const script = resolve(__dirname, '../../../scripts/release/identity.mjs')
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function run(version: string, env: Record<string, string> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'release-identity-'))
  dirs.push(cwd)
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'agent-code', version }))
  const output = join(cwd, 'github-output')
  writeFileSync(output, '')
  const result = spawnSync(process.execPath, [script], {
    cwd, encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', GITHUB_OUTPUT: output, ...env },
  })
  const outputs = Object.fromEntries(readFileSync(output, 'utf8').split('\n').filter(Boolean).map(line => {
    const at = line.indexOf('=')
    return [line.slice(0, at), line.slice(at + 1)]
  }))
  return { status: result.status, stderr: result.stderr, outputs }
}

describe('release identity', () => {
  it('a manual release of 0.1.3 is v0.1.3, stable, and becomes latest', () => {
    const result = run('0.1.3')
    expect(result.status).toBe(0)
    expect(result.outputs).toEqual({ tag: 'v0.1.3', name: 'Agent Code 0.1.3', prerelease: 'false', make_latest: 'true' })
  })

  it('refuses a prerelease version before any build, pointing at the preview workflow', () => {
    for (const version of ['0.0.2-beta.1', '0.1.4-preview.20260924']) {
      const result = run(version)
      expect(result.status).toBe(1)
      expect(result.stderr).toMatch(/always stable/)
      expect(result.stderr).toMatch(/preview workflow/)
      expect(result.outputs).toEqual({})
    }
  })

  it('ignores a leftover CHANNEL=prerelease: a manual release can never be published as a beta', () => {
    // An old dispatch script might still send it. The input no longer
    // exists, and the script must not honour it either.
    expect(run('0.1.3', { CHANNEL: 'prerelease' }).outputs).toMatchObject({ prerelease: 'false', make_latest: 'true' })
  })

  it('refuses a tag that does not match package.json', () => {
    const result = run('0.1.3', { RELEASE_TAG: 'v0.1.2' })
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/v0\.1\.3.*v0\.1\.2/)
  })

  it('accepts an explicit matching tag and a custom name', () => {
    const result = run('0.1.3', { RELEASE_TAG: 'v0.1.3', RELEASE_NAME: 'Agent Code 0.1.3 — usage limits' })
    expect(result.outputs).toMatchObject({ tag: 'v0.1.3', name: 'Agent Code 0.1.3 — usage limits' })
  })

  it('reads only the version core: build metadata with a hyphen is still stable', () => {
    expect(run('0.1.0+build-5').outputs).toMatchObject({ prerelease: 'false', make_latest: 'true' })
  })

  it('refuses a name or tag with a line break, which could override the validated tag in GITHUB_OUTPUT', () => {
    const result = run('0.1.3', { RELEASE_NAME: 'Agent Code\ntag=v9.9.9' })
    expect(result.status).toBe(1)
    expect(result.outputs).toEqual({})
  })
})
