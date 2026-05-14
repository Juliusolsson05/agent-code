#!/usr/bin/env node
// Download the pinned mitmproxy archive from the upstream download
// server into third_party/mitmproxy/cache/<platform>-<arch>/, verifying
// the SHA-256 against manifest.json BEFORE renaming the partial file
// into place.
//
// Usage:
//   node scripts/runtime-tools/fetch-mitmproxy.mjs                 # current platform
//   node scripts/runtime-tools/fetch-mitmproxy.mjs --all           # every platform in manifest
//   node scripts/runtime-tools/fetch-mitmproxy.mjs --platform darwin-x86_64
//
// WHY this is NOT a postinstall hook:
//   The mitmproxy archive is ~52 MiB per arch. Dev contributors must
//   not be forced to download it just to run the app from source. CI
//   release jobs invoke this explicitly via `npm run runtime:prepare:mac`.
//
// WHY we hash before writing the final filename:
//   A partial / corrupted file at the canonical cache path would
//   silently poison the subsequent verify + packaging steps. The
//   partial-then-rename pattern means the cache only ever contains
//   bytes that already matched the manifest.

import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, stat, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')
const manifestPath = join(repoRoot, 'third_party', 'mitmproxy', 'manifest.json')
const cacheRoot = join(repoRoot, 'third_party', 'mitmproxy', 'cache')

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
  // Node's process.arch is `x64` but upstream mitmproxy archives use
  // `x86_64` in their filenames. The manifest follows upstream so URL
  // templating works directly; we map Node-arch -> manifest-arch here
  // and ONLY here.
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
  // WHY filename lives on the platform entry (not derived from
  // {platform}/{arch}):
  //   Upstream mitmproxy filenames use "macos" while Node's
  //   process.platform is "darwin". Earlier draft assumed the two
  //   were identical and built bad URLs like
  //   mitmproxy-X-darwin-arm64.tar.gz (404). The per-platform
  //   filename field puts the upstream filename convention right
  //   next to the hash that verifies it, so the manifest is the
  //   single source of truth and we never re-derive cross-platform
  //   naming in code.
  const filename = platform.filename.replaceAll('{version}', manifest.version)
  const urlBase = manifest.urlBase.replaceAll('{version}', manifest.version)
  const url = `${urlBase}/${filename}`
  const targetDir = join(cacheRoot, platformKey)
  const targetFile = join(targetDir, filename)
  const tmpFile = `${targetFile}.partial`

  // Idempotency: if the existing cache file already matches the
  // manifest hash, skip the download. Makes re-runs in CI cheap and
  // safe.
  if (await fileMatchesHash(targetFile, platform.sha256)) {
    process.stdout.write(
      `[fetch-mitmproxy] cache hit for ${platformKey} (sha256 ${platform.sha256.slice(0, 12)})\n`,
    )
    return
  }

  await mkdir(targetDir, { recursive: true })
  process.stdout.write(`[fetch-mitmproxy] downloading ${url}\n`)
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
    createWriteStream(tmpFile),
  )

  const digest = hash.digest('hex')
  if (digest !== platform.sha256) {
    await safeUnlink(tmpFile)
    throw new Error(
      `Hash mismatch for ${platformKey}.\n` +
        `  manifest: ${platform.sha256}\n` +
        `  download: ${digest}\n` +
        `  refusing to write; manifest must be updated or download retried.`,
    )
  }

  const st = await stat(tmpFile)
  if (platform.bytes && st.size !== platform.bytes) {
    await safeUnlink(tmpFile)
    throw new Error(
      `Byte-size mismatch for ${platformKey}: expected ${platform.bytes}, got ${st.size}`,
    )
  }

  await rename(tmpFile, targetFile)
  process.stdout.write(
    `[fetch-mitmproxy] verified ${platformKey} -> ${targetFile}\n`,
  )
}

async function fileMatchesHash(path, expected) {
  try {
    const buf = await readFile(path)
    const digest = createHash('sha256').update(buf).digest('hex')
    return digest === expected
  } catch {
    return false
  }
}

async function safeUnlink(path) {
  try {
    await unlink(path)
  } catch {
    // best effort
  }
}

main().catch(err => {
  process.stderr.write(
    `[fetch-mitmproxy] ${err instanceof Error ? err.message : String(err)}\n`,
  )
  process.exit(1)
})
