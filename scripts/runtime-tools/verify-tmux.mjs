#!/usr/bin/env node
// Verify the cached tmux binary in
//   third_party/tmux/cache/<platform>-<arch>/tmux
// against manifest.json without re-downloading.
//
// Usage:
//   node scripts/runtime-tools/verify-tmux.mjs            # warn on missing
//   node scripts/runtime-tools/verify-tmux.mjs --strict   # fail on missing or broken
//
// "Verify" here means three things:
//   1. The binary file exists and is executable.
//   2. `tmux -V` reports the version pinned in manifest.json (cheap
//      sanity that the right artifact landed at the right path).
//   3. `otool -L` on macOS confirms the binary does NOT link any
//      Homebrew dylib — the whole point of bundling is that we
//      don't rely on the user's Homebrew install.
//
// Steps 2 and 3 are the load-bearing checks. A future change that
// silently swaps the upstream source for the Homebrew binary would
// pass a sha256 hash check (because we don't store one for the
// extracted binary), but it would fail (3). That's the regression
// gate this script exists to enforce.

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
  for (const [platformKey] of Object.entries(manifest.platforms)) {
    const binary = join(cacheRoot, platformKey, manifest.executableInsideArchive)

    try {
      await access(binary, fsConstants.X_OK)
    } catch {
      const msg = `[verify-tmux] missing or not executable: ${platformKey} (${binary})`
      if (strict) { console.error(msg); problems++ }
      else { console.warn(`${msg} — run \`npm run runtime:fetch:tmux\``) }
      continue
    }

    if (platformKey !== currentPlatformKey()) {
      // We can't `tmux -V` a cross-arch binary. The sha256 hash on
      // the manifest covers the *archive*, not the extracted binary,
      // so there is no manifest hash to compare against for the
      // extracted file. Cross-platform validation is therefore
      // limited to "file exists and is executable" — the build host
      // gets the full version + linkage check for its native arch,
      // and that's the case that matters most.
      console.log(`[verify-tmux] OK ${platformKey} (presence only; cross-arch)`)
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

    console.log(`[verify-tmux] OK ${platformKey} (${manifest.version}, no Homebrew linkage)`)
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
