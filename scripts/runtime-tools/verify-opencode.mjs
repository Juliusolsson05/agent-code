#!/usr/bin/env node
// Verify the cached opencode binary in
//   third_party/opencode/cache/<platform>-<arch>/opencode
// against manifest.json without re-downloading.
//
// Usage:
//   node scripts/runtime-tools/verify-opencode.mjs            # warn on missing
//   node scripts/runtime-tools/verify-opencode.mjs --strict   # fail on missing or broken
//
// Strict verification has three layers (same shape as verify-tmux):
//
//   1. Content identity (every arch): sha256 of the cached binary
//      must equal `manifest.platforms.<key>.binarySha256`. The only
//      layer that works cross-arch — a release builder on arm64 gets
//      real tamper detection for the x86_64 binary it just fetched
//      without needing Rosetta to spawn it.
//
//   2. Runtime smoke test (native arch only): `opencode --version`
//      must print the pinned version (bare semver, no tool prefix).
//      Catches "hash matches but the OS refuses to exec".
//
//   3. Linkage gate (darwin, native arch only): `otool -L` must report
//      no Homebrew dylib references. The whole point of bundling is
//      that we never depend on the user's Homebrew; upstream's release
//      binary links only system dylibs (libSystem, libc++, libicucore,
//      libresolv — checked when the pin landed), so any Homebrew hit
//      means the artifact source changed out from under the manifest.

import { createHash } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')
const manifestPath = join(repoRoot, 'third_party', 'opencode', 'manifest.json')
const cacheRoot = join(repoRoot, 'third_party', 'opencode', 'cache')

async function main() {
  const strict = process.argv.includes('--strict')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))

  let problems = 0
  for (const [platformKey, platform] of Object.entries(manifest.platforms)) {
    const binary = join(cacheRoot, platformKey, manifest.executableInsideArchive)

    try {
      await access(binary, fsConstants.X_OK)
    } catch {
      const msg = `[verify-opencode] missing or not executable: ${platformKey} (${binary})`
      if (strict) { console.error(msg); problems++ }
      else { console.warn(`${msg} — run \`npm run runtime:fetch:opencode\``) }
      continue
    }

    if (!platform.binarySha256) {
      console.error(
        `[verify-opencode] ${platformKey}: manifest is missing binarySha256. ` +
          `Compute and pin it before this script can validate the cache.`,
      )
      problems++
      continue
    }

    const buf = await readFile(binary)
    const digest = createHash('sha256').update(buf).digest('hex')
    if (digest !== platform.binarySha256) {
      console.error(
        `[verify-opencode] ${platformKey}: binary hash mismatch:\n` +
          `  manifest: ${platform.binarySha256}\n` +
          `  on-disk:  ${digest}`,
      )
      problems++
      continue
    }

    if (platformKey !== currentPlatformKey()) {
      // Cross-arch: the hash gate above is the check; spawning an
      // x86_64 Mach-O on an arm64 host needs Rosetta a clean builder
      // does not have.
      console.log(`[verify-opencode] OK ${platformKey} (hash matches; cross-arch)`)
      continue
    }

    const versionOk = await binaryReportsVersion(binary, manifest.version)
    if (!versionOk) {
      console.error(
        `[verify-opencode] ${platformKey}: \`opencode --version\` did not print "${manifest.version}"`,
      )
      problems++
      continue
    }

    if (process.platform === 'darwin') {
      const homebrewLinkage = await detectHomebrewLinkage(binary)
      if (homebrewLinkage.length > 0) {
        console.error(
          `[verify-opencode] ${platformKey}: binary links Homebrew dylibs:\n  ` +
            homebrewLinkage.join('\n  '),
        )
        problems++
        continue
      }
    }

    console.log(`[verify-opencode] OK ${platformKey} (${manifest.version}, hash + linkage clean)`)
  }

  if (problems > 0) {
    console.error(`[verify-opencode] ${problems} problem(s) found`)
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
    const child = spawn(path, ['--version'])
    child.stdout.on('data', b => (out += b))
    child.stderr.on('data', b => (out += b))
    child.on('error', () => res(false))
    child.on('exit', code => res(code === 0 && out.trim().includes(expectedVersion)))
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
  console.error(`[verify-opencode] ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
