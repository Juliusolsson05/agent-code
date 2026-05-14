#!/usr/bin/env node
// Download the pinned tmux archive from upstream tmux/tmux-builds,
// verify the SHA-256 against manifest.json, extract the inner `tmux`
// executable, and place it at
//   third_party/tmux/cache/<platform>-<arch>/tmux
// with the executable bit set.
//
// Usage:
//   node scripts/runtime-tools/fetch-tmux.mjs                 # current platform
//   node scripts/runtime-tools/fetch-tmux.mjs --all           # every platform in manifest
//   node scripts/runtime-tools/fetch-tmux.mjs --platform darwin-x86_64
//
// WHY tmux's cache stores the extracted binary, not the archive:
//   For mitmproxy we ship the full .tar.gz inside the packaged app
//   and extract on first launch because the contents are a multi-file
//   .app bundle. tmux is a single 1.6 MB binary — extracting it once
//   at fetch time and committing nothing keeps the runtime resolver
//   in `src/main/setup/runtimeTools.ts` trivial: it just returns the
//   already-extracted binary's path from app.asar.unpacked, no
//   userData copy, no marker, no atomic rename. Two different
//   resolution shapes for the two tools is fine; the underlying
//   manifest schema stays identical.
//
// WHY this is NOT a postinstall hook:
//   Same rule as fetch-mitmproxy: dev contributors must not pay a
//   download cost on `npm install`. CI release jobs invoke this
//   explicitly through `npm run runtime:prepare:mac`.

import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import {
  chmod, copyFile, mkdir, readFile, rm, stat, unlink,
} from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { spawn } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')
const manifestPath = join(repoRoot, 'third_party', 'tmux', 'manifest.json')
const cacheRoot = join(repoRoot, 'third_party', 'tmux', 'cache')
const tmpRoot = join(cacheRoot, '.download')

async function main() {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const args = process.argv.slice(2)
  const all = args.includes('--all')
  const platformArg = readFlag(args, '--platform')

  const targets = all
    ? Object.keys(manifest.platforms)
    : platformArg
      ? [platformArg]
      : [currentPlatformKey()]

  for (const platformKey of targets) {
    const platform = manifest.platforms[platformKey]
    if (!platform) {
      throw new Error(
        `No manifest entry for "${platformKey}". ` +
          `Known platforms: ${Object.keys(manifest.platforms).join(', ')}`,
      )
    }
    await fetchOne(manifest, platformKey, platform)
  }
}

function currentPlatformKey() {
  // Same arch convention as fetch-mitmproxy and runtimeTools.ts:
  // Node's `process.arch` -> manifest arch via the single x64 -> x86_64
  // remap.
  const archMap = { x64: 'x86_64', arm64: 'arm64' }
  const arch = archMap[process.arch]
  if (!arch) throw new Error(`Unsupported arch: ${process.arch}`)
  return `${process.platform}-${arch}`
}

function readFlag(argv, name) {
  const i = argv.indexOf(name)
  if (i === -1) return null
  return argv[i + 1] ?? null
}

async function fetchOne(manifest, platformKey, platform) {
  const filename = platform.filename.replaceAll('{version}', manifest.version)
  const urlBase = manifest.urlBase.replaceAll('{version}', manifest.version)
  const url = `${urlBase}/${filename}`

  const targetDir = join(cacheRoot, platformKey)
  const targetBinary = join(targetDir, manifest.executableInsideArchive)

  // Idempotency: if the cached binary already runs and reports the
  // expected version, skip the whole download+extract. This lets CI
  // re-runs and local re-fetches finish in milliseconds.
  if (await binaryMatchesVersion(targetBinary, manifest.version)) {
    process.stdout.write(
      `[fetch-tmux] cache hit for ${platformKey} (${manifest.executableInsideArchive} reports ${manifest.version})\n`,
    )
    return
  }

  await mkdir(targetDir, { recursive: true })
  await mkdir(tmpRoot, { recursive: true })
  const archivePath = join(tmpRoot, `${platformKey}-${filename}.partial`)

  process.stdout.write(`[fetch-tmux] downloading ${url}\n`)
  const res = await fetch(url)
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`)
  }

  const hash = createHash('sha256')
  await pipeline(
    res.body,
    async function* (source) {
      for await (const chunk of source) {
        hash.update(chunk)
        yield chunk
      }
    },
    createWriteStream(archivePath),
  )

  const digest = hash.digest('hex')
  if (digest !== platform.sha256) {
    await safeUnlink(archivePath)
    throw new Error(
      `Archive hash mismatch for ${platformKey}.\n` +
        `  manifest: ${platform.sha256}\n` +
        `  download: ${digest}\n` +
        `  refusing to extract; manifest must be updated or download retried.`,
    )
  }

  const st = await stat(archivePath)
  if (platform.bytes && st.size !== platform.bytes) {
    await safeUnlink(archivePath)
    throw new Error(
      `Byte-size mismatch for ${platformKey}: expected ${platform.bytes}, got ${st.size}`,
    )
  }

  // Extract into a sibling staging dir, then move the single binary
  // into the canonical cache path. Doing the extract in a staging
  // dir means a Ctrl-C between extract and chmod leaves the previous
  // cache (if any) intact; the next run wipes .download and starts
  // clean.
  const stageDir = join(tmpRoot, `${platformKey}-stage`)
  await rm(stageDir, { recursive: true, force: true })
  await mkdir(stageDir, { recursive: true })
  await extractTarGz(archivePath, stageDir)

  const stageBinary = join(stageDir, manifest.executableInsideArchive)
  await stat(stageBinary) // throws if missing
  await copyFile(stageBinary, targetBinary)
  await chmod(targetBinary, 0o755)

  // Clean up staging + downloaded archive. The cache directory
  // ultimately contains exactly one file per platform (the binary)
  // and nothing else.
  await safeUnlink(archivePath)
  await rm(stageDir, { recursive: true, force: true })
  await rm(tmpRoot, { recursive: true, force: true }).catch(() => {})

  // Final sanity: the just-extracted binary must run and report the
  // pinned version. We don't ship a manifest hash for the inner
  // binary (upstream may rebuild without bumping the version label),
  // so the cheapest check that confirms the right artifact landed is
  // `tmux -V`.
  if (!(await binaryMatchesVersion(targetBinary, manifest.version))) {
    throw new Error(
      `Extracted ${manifest.executableInsideArchive} did not report version ${manifest.version}; refusing to leave a broken cache.`,
    )
  }

  process.stdout.write(
    `[fetch-tmux] verified ${platformKey} -> ${targetBinary}\n`,
  )
}

async function binaryMatchesVersion(path, expectedVersion) {
  try {
    const st = await stat(path)
    if (!st.isFile()) return false
  } catch {
    return false
  }
  return await new Promise(res => {
    let stdout = ''
    let stderr = ''
    const child = spawn(path, ['-V'])
    child.stdout.on('data', b => (stdout += b))
    child.stderr.on('data', b => (stderr += b))
    child.on('error', () => res(false))
    child.on('exit', code => {
      if (code !== 0) return res(false)
      const out = (stdout + stderr).trim()
      // `tmux -V` prints exactly: `tmux 3.6a`
      res(out.includes(expectedVersion))
    })
  })
}

async function safeUnlink(path) {
  try { await unlink(path) } catch { /* best effort */ }
}

function extractTarGz(archive, destDir) {
  return new Promise((resolve, reject) => {
    // /usr/bin/tar is built into macOS and supports -xzf out of the
    // box. Spawning it rather than depending on a node-tar library
    // keeps the dev-time toolchain free of extra runtime packages.
    const child = spawn('/usr/bin/tar', ['-xzf', archive, '-C', destDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', c => { stderr += String(c) })
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) resolve()
      else reject(new Error(`tar exit ${code}: ${stderr.trim()}`))
    })
  })
}

main().catch(err => {
  process.stderr.write(
    `[fetch-tmux] ${err instanceof Error ? err.message : String(err)}\n`,
  )
  process.exit(1)
})
