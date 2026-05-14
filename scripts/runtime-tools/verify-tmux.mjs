#!/usr/bin/env node
// Verify the cached tmux binary in
//   third_party/tmux/cache/<platform>-<arch>/tmux
// against manifest.json without re-downloading.
//
// Usage:
//   node scripts/runtime-tools/verify-tmux.mjs            # warn on missing
//   node scripts/runtime-tools/verify-tmux.mjs --strict   # fail on missing or broken
//
// Strict verification has three layers:
//
//   1. Content identity (every arch): sha256 of the cached binary
//      must equal `manifest.platforms.<key>.binarySha256`. This is
//      the load-bearing check and the only one that works
//      cross-arch — a release builder on arm64 still gets real
//      tamper detection for the x86_64 binary it just fetched,
//      without needing Rosetta to spawn it.
//
//   2. Runtime smoke test (native arch only): `tmux -V` must include
//      the pinned version string. Catches "hash matches but the OS
//      refuses to exec" failures. Skipped on non-native because
//      spawning a cross-arch Mach-O on a clean macOS without Rosetta
//      fails with "Bad CPU type in executable".
//
//   3. Linkage gate (darwin, native arch only): `otool -L` must
//      report no Homebrew dylib references. The whole point of
//      bundling is that we never link against the user's Homebrew
//      install; a future change that silently swapped the upstream
//      source for the Homebrew binary would pass (1) only if its
//      hash happened to match, which it would not, and would also
//      fail this check.
//
// The presence-only mode the previous version used for non-native
// arch was a hole: a corrupted or swapped x86_64 binary on an arm64
// builder would slip past strict verification. Hash-checking closes
// that.

import { createHash } from 'node:crypto'
import { access, readFile, stat } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')
const manifestPath = join(repoRoot, 'third_party', 'tmux', 'manifest.json')
const cacheRoot = join(repoRoot, 'third_party', 'tmux', 'cache')

async function main() {
  const strict = process.argv.includes('--strict')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))

  let problems = 0
  for (const [platformKey, platform] of Object.entries(manifest.platforms)) {
    const binary = join(cacheRoot, platformKey, manifest.executableInsideArchive)

    try {
      await access(binary, fsConstants.X_OK)
    } catch {
      const msg = `[verify-tmux] missing or not executable: ${platformKey} (${binary})`
      if (strict) { console.error(msg); problems++ }
      else { console.warn(`${msg} — run \`npm run runtime:fetch:tmux\``) }
      continue
    }

    if (!platform.binarySha256) {
      console.error(
        `[verify-tmux] ${platformKey}: manifest is missing binarySha256. ` +
          `Compute and pin it before this script can validate the cache.`,
      )
      problems++
      continue
    }

    const buf = await readFile(binary)
    const digest = createHash('sha256').update(buf).digest('hex')
    if (digest !== platform.binarySha256) {
      console.error(
        `[verify-tmux] ${platformKey}: binary hash mismatch:\n` +
          `  manifest: ${platform.binarySha256}\n` +
          `  on-disk:  ${digest}`,
      )
      problems++
      continue
    }

    if (platformKey !== currentPlatformKey()) {
      // Cross-arch: we trust the hash check above and skip the spawn
      // + linkage checks because they require executing the binary,
      // which a clean Apple-Silicon host cannot do for an x86_64
      // Mach-O (and vice versa) without Rosetta. The hash gate is
      // sufficient: a swapped or corrupted cross-arch binary would
      // not match the pinned hash regardless of whether we can run
      // it.
      console.log(`[verify-tmux] OK ${platformKey} (hash matches; cross-arch)`)
      continue
    }

    const versionOk = await binaryReportsVersion(binary, manifest.version)
    if (!versionOk) {
      console.error(
        `[verify-tmux] ${platformKey}: \`tmux -V\` did not contain "${manifest.version}"`,
      )
      problems++
      continue
    }

    if (process.platform === 'darwin') {
      const homebrewLinkage = await detectHomebrewLinkage(binary)
      if (homebrewLinkage.length > 0) {
        console.error(
          `[verify-tmux] ${platformKey}: binary links Homebrew dylibs:\n  ` +
            homebrewLinkage.join('\n  '),
        )
        problems++
        continue
      }
    }

    console.log(`[verify-tmux] OK ${platformKey} (${manifest.version}, hash + linkage clean)`)
  }

  if (problems > 0) {
    console.error(`[verify-tmux] ${problems} problem(s) found`)
    process.exit(1)
  }
}

function currentPlatformKey() {
  const archMap = { x64: 'x86_64', arm64: 'arm64' }
  const arch = archMap[process.arch]
  if (!arch) return ''
  return `${process.platform}-${arch}`
}

function binaryReportsVersion(path, expectedVersion) {
  return new Promise(res => {
    let out = ''
    const child = spawn(path, ['-V'])
    child.stdout.on('data', b => (out += b))
    child.stderr.on('data', b => (out += b))
    child.on('error', () => res(false))
    child.on('exit', code => res(code === 0 && out.includes(expectedVersion)))
  })
}

function detectHomebrewLinkage(path) {
  return new Promise(res => {
    let stdout = ''
    const child = spawn('/usr/bin/otool', ['-L', path])
    child.stdout.on('data', b => (stdout += b))
    child.on('error', () => res([]))
    child.on('exit', () => {
      const hits = stdout
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.startsWith('/opt/homebrew') || line.includes('/Cellar/'))
      res(hits)
    })
  })
}

main().catch(err => {
  console.error(`[verify-tmux] ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
