import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// System tests for scripts/release/verify-update-feed.mjs: the check that the
// update feed (latest-mac.yml) only names files that exist in release/.
//
// WHY this exists (#1129): v0.1.0–v0.1.2 shipped a feed naming
// `Agent-Code-0.1.2-arm64.zip` while the artifact was built as
// `Agent Code-0.1.2-arm64.zip` and uploaded by GitHub as
// `Agent.Code-0.1.2-arm64.zip`. Every self-update download 404'd and nothing
// in the pipeline noticed. The check runs after packaging and before upload,
// where the feed and the files still sit side by side.
//
// The feed here is the REAL published v0.1.2 feed (recorded 2026-09-22 from
// the release), and the "old" file names are exactly what the old
// artifactName template produced. The script runs as a real child process.

const script = resolve(__dirname, '../../../scripts/release/verify-update-feed.mjs')
const recordedFeed = resolve(__dirname, '../../fixtures/release-update-feed/latest-mac-v0.1.2.yml')
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function releaseDir(files: string[], feed: string | null = recordedFeed) {
  const cwd = mkdtempSync(join(tmpdir(), 'release-update-feed-'))
  dirs.push(cwd)
  const release = join(cwd, 'release')
  mkdirSync(release)
  if (feed) copyFileSync(feed, join(release, 'latest-mac.yml'))
  for (const name of files) writeFileSync(join(release, name), 'artifact')
  return cwd
}

function verify(cwd: string) {
  const result = spawnSync(process.execPath, [script], { cwd, encoding: 'utf8' })
  return { status: result.status, stderr: result.stderr, stdout: result.stdout }
}

const artifacts = (prefix: string) => ['x64', 'arm64'].flatMap(arch => [
  `${prefix}-0.1.2-${arch}.zip`,
  `${prefix}-0.1.2-${arch}.zip.blockmap`,
  `${prefix}-0.1.2-${arch}.dmg`,
])

describe('update feed verification', () => {
  it('fails on the v0.1.2 layout: the feed names Agent-Code-… but the build produced Agent Code-…', () => {
    const result = verify(releaseDir(artifacts('Agent Code')))
    expect(result.status).toBe(1)
    // The message must name the file the updater would have asked for, so
    // the failing release run says exactly what is wrong.
    expect(result.stderr).toContain('Agent-Code-0.1.2-arm64.zip')
  })

  it('passes when every file the feed names exists under exactly that name', () => {
    const result = verify(releaseDir(artifacts('Agent-Code')))
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  })

  it('fails when a single referenced file is missing, not just when all are', () => {
    const files = artifacts('Agent-Code').filter(name => name !== 'Agent-Code-0.1.2-x64.dmg')
    const result = verify(releaseDir(files))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Agent-Code-0.1.2-x64.dmg')
  })

  it('fails when there is no feed at all, since the updater then sees no release', () => {
    const result = verify(releaseDir(artifacts('Agent-Code'), null))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('latest-mac.yml')
  })
})
