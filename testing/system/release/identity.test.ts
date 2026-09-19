import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// System tests for scripts/release/identity.mjs: which tag, name and release
// flags a manual release dispatch publishes (release.yml, validate-release).
//
// WHY these rules are tested at all: they decide whether a signed build
// becomes `releases/latest`, the file the landing page's download button and
// every "latest" link resolve to. The previous inline bash only compared the
// tag with package.json, and the release step hardcoded `prerelease: true`,
// so a stable release could not be made at all (Stage 8 of
// docs/decomposition/release-readiness.md).
//
// The script runs as a REAL child process with the env and GITHUB_OUTPUT file
// the workflow gives it. The versions are real: `0.0.2-beta.1` is the version
// of the published beta (gh release list, 2026-09-19) and of package.json
// today; `0.1.0` is the stable number the ledger defaults to.

const script = resolve(__dirname, '../../../scripts/release/identity.mjs')
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function run(version: string, env: Record<string, string>) {
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
  it('a stable release of 0.1.0 is v0.1.0, not a prerelease, and becomes latest', () => {
    const result = run('0.1.0', { CHANNEL: 'stable' })
    expect(result.status).toBe(0)
    expect(result.outputs).toEqual({ tag: 'v0.1.0', name: 'Agent Code 0.1.0', prerelease: 'false', make_latest: 'true' })
  })

  it('a prerelease is published exactly as the betas were: prerelease, never latest', () => {
    const result = run('0.0.2-beta.1', { CHANNEL: 'prerelease' })
    expect(result.status).toBe(0)
    expect(result.outputs).toMatchObject({ tag: 'v0.0.2-beta.1', prerelease: 'true', make_latest: 'false' })
  })

  it('defaults to the prerelease channel when none is given', () => {
    // An old dispatch form (or a CLI call without the input) must never
    // promote a build to latest by accident.
    expect(run('0.0.2-beta.1', {}).outputs).toMatchObject({ prerelease: 'true', make_latest: 'false' })
  })

  it('refuses a stable release of a prerelease version, before any build', () => {
    const result = run('0.0.2-beta.1', { CHANNEL: 'stable' })
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/stable.*0\.0\.2-beta\.1/)
    expect(result.outputs).toEqual({})
  })

  it('refuses a prerelease of a stable version, which would take the stable tag', () => {
    const result = run('0.1.0', { CHANNEL: 'prerelease' })
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/prerelease.*0\.1\.0/)
  })

  it('refuses a tag that does not match package.json', () => {
    // The check the old inline bash made; kept.
    const result = run('0.1.0', { CHANNEL: 'stable', RELEASE_TAG: 'v0.0.2-beta.1' })
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/v0\.1\.0.*v0\.0\.2-beta\.1/)
  })

  it('accepts an explicit matching tag and a custom name', () => {
    const result = run('0.1.0', { CHANNEL: 'stable', RELEASE_TAG: 'v0.1.0', RELEASE_NAME: 'Agent Code 0.1' })
    expect(result.outputs).toMatchObject({ tag: 'v0.1.0', name: 'Agent Code 0.1' })
  })

  it('reads only the version core: build metadata with a hyphen is still stable', () => {
    expect(run('0.1.0+build-5', { CHANNEL: 'stable' }).outputs).toMatchObject({ prerelease: 'false', make_latest: 'true' })
  })

  it('refuses a name or tag with a line break, which could override the validated tag in GITHUB_OUTPUT', () => {
    const result = run('0.0.2-beta.1', { CHANNEL: 'prerelease', RELEASE_NAME: 'Agent Code\ntag=v9.9.9' })
    expect(result.status).toBe(1)
    expect(result.outputs).toEqual({})
  })

  it('suggests a prerelease of the NEXT version, which sorts after the stable', () => {
    expect(run('0.1.0', { CHANNEL: 'prerelease' }).stderr).toMatch(/0\.1\.1-beta\.1/)
  })

  it('refuses an unknown channel instead of guessing', () => {
    expect(run('0.1.0', { CHANNEL: 'latest' }).status).toBe(1)
  })
})
