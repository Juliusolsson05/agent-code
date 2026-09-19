#!/usr/bin/env node
// Download the pinned opencode CLI zip from upstream
// anomalyco/opencode releases, verify the SHA-256 + byte size against
// manifest.json, extract the inner `opencode` executable, and place it
// at
//   third_party/opencode/cache/<platform>-<arch>/opencode
// with the executable bit set.
//
// Usage:
//   node scripts/runtime-tools/fetch-opencode.mjs               # current platform
//   node scripts/runtime-tools/fetch-opencode.mjs --all         # every platform in manifest
//   node scripts/runtime-tools/fetch-opencode.mjs --platform darwin-x86_64
//
// WHY opencode's cache stores the extracted binary, not the archive:
//   Same call as tmux: a single self-contained Mach-O (~144 MB raw,
//   links only system dylibs) needs no first-launch extraction, so the
//   runtime resolver in `src/main/setup/runtimeTools.ts` stays a plain
//   find + chmod + probe with no userData copy, no marker, no atomic
//   rename. Only mitmproxy (a multi-file PyInstaller .app) ships its
//   archive and extracts lazily.
//
// WHY we pin BOTH the archive sha256 AND the extracted binarySha256:
//   The archive hash verifies what we downloaded; the binary hash
//   verifies what we ship, and lets `verify-opencode.mjs` validate the
//   cache without spawning the binary. Spawning a cross-arch Mach-O on
//   a clean Apple-Silicon host fails with "Bad CPU type in executable"
//   (no Rosetta), so hash-based identity is the only cross-arch check
//   that works on every builder.
//
// WHY `/usr/bin/unzip` and not a node unzip library: same rule as
//   tmux's `/usr/bin/tar` — macOS ships it, the upstream artifact is a
//   plain single-entry zip with no special attributes, and shelling
//   out keeps the dev toolchain free of an extra runtime package.
//
// WHY this is NOT a postinstall hook:
//   Same rule as the other fetch scripts: dev contributors must not pay
//   a ~46 MB download on `npm install`. CI release jobs invoke this
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
const manifestPath = join(repoRoot, 'third_party', 'opencode', 'manifest.json')
const cacheRoot = join(repoRoot, 'third_party', 'opencode', 'cache')
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
    if (!platform.binarySha256) {
      throw new Error(
        `Manifest is missing binarySha256 for ${platformKey}. ` +
          `Compute it with \`shasum -a 256 third_party/opencode/cache/${platformKey}/opencode\` ` +
          `after a fresh download, then pin the value in third_party/opencode/manifest.json.`,
      )
    }
    await fetchOne(manifest, platformKey, platform)
  }
}

function currentPlatformKey() {
  // Same arch convention as the other fetch scripts and runtimeTools.ts:
  // Node's `process.arch` -> manifest arch via the single x64 -> x86_64
  // remap. opencode upstream names its x64 assets "x64(-baseline)" but
  // our manifest normalizes to x86_64 so this one mapping stays shared.
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

  // Cache-hit detection by content hash, never by version-string output:
  // a swapped or corrupted binary that happens to print the right
  // version must not pass. The binary hash is platform-agnostic.
  if (await fileMatchesHash(targetBinary, platform.binarySha256)) {
    process.stdout.write(
      `[fetch-opencode] cache hit for ${platformKey} (binary sha256 ${platform.binarySha256.slice(0, 12)})\n`,
    )
    return
  }

  await mkdir(targetDir, { recursive: true })
  await mkdir(tmpRoot, { recursive: true })
  const archivePath = join(tmpRoot, `${platformKey}-${filename}.partial`)

  process.stdout.write(`[fetch-opencode] downloading ${url}\n`)
  const res = await fetch(url)
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`)
  }

  const archiveHash = createHash('sha256')
  await pipeline(
    res.body,
    async function* (source) {
      for await (const chunk of source) {
        archiveHash.update(chunk)
        yield chunk
      }
    },
    createWriteStream(archivePath),
  )

  const archiveDigest = archiveHash.digest('hex')
  if (archiveDigest !== platform.sha256) {
    await safeUnlink(archivePath)
    throw new Error(
      `Archive hash mismatch for ${platformKey}.\n` +
        `  manifest: ${platform.sha256}\n` +
        `  download: ${archiveDigest}\n` +
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
  // into the canonical cache path. A Ctrl-C between extract and chmod
  // leaves the previous cache (if any) intact; the next run wipes
  // .download and starts clean.
  const stageDir = join(tmpRoot, `${platformKey}-stage`)
  await rm(stageDir, { recursive: true, force: true })
  await mkdir(stageDir, { recursive: true })
  await extractZip(archivePath, stageDir)

  const stageBinary = join(stageDir, manifest.executableInsideArchive)
  await stat(stageBinary) // throws if missing

  // Verify the EXTRACTED binary's content hash before it becomes the
  // cache. This is the load-bearing identity check: what ships out of
  // `out/main/runtime/opencode/...` is exactly this file.
  if (!(await fileMatchesHash(stageBinary, platform.binarySha256))) {
    await rm(stageDir, { recursive: true, force: true }).catch(() => {})
    await safeUnlink(archivePath)
    throw new Error(
      `Extracted binary hash mismatch for ${platformKey}; refusing to commit it to the cache.`,
    )
  }

  await copyFile(stageBinary, targetBinary)
  await chmod(targetBinary, 0o755)

  // Clean up staging + downloaded archive. The cache directory
  // ultimately contains exactly one file per platform and nothing else.
  await safeUnlink(archivePath)
  await rm(stageDir, { recursive: true, force: true })
  await rm(tmpRoot, { recursive: true, force: true }).catch(() => {})

  // Native-arch sanity: confirm the binary runs and reports the pinned
  // version. Catches "hash matches but the OS rejects the exec" class
  // failures; skipped cross-arch because that spawn needs Rosetta.
  // opencode prints the bare semver for `--version` (no tool-name
  // prefix), so an `includes` match is the correct test.
  if (platformKey === currentPlatformKey()) {
    if (!(await binaryReportsVersion(targetBinary, manifest.version))) {
      throw new Error(
        `Extracted ${manifest.executableInsideArchive} did not report version ${manifest.version}; refusing to leave a broken cache.`,
      )
    }
  }

  process.stdout.write(
    `[fetch-opencode] verified ${platformKey} -> ${targetBinary}\n`,
  )
}

async function fileMatchesHash(path, expected) {
  try {
    const buf = await readFile(path)
    return createHash('sha256').update(buf).digest('hex') === expected
  } catch {
    return false
  }
}

async function binaryReportsVersion(path, expectedVersion) {
  try {
    const st = await stat(path)
    if (!st.isFile()) return false
  } catch {
    return false
  }
  return await new Promise(res => {
    let out = ''
    const child = spawn(path, ['--version'])
    child.stdout.on('data', b => (out += b))
    child.stderr.on('data', b => (out += b))
    child.on('error', () => res(false))
    child.on('exit', code => res(code === 0 && out.trim().includes(expectedVersion)))
  })
}

async function safeUnlink(path) {
  try { await unlink(path) } catch { /* best effort */ }
}

function extractZip(archive, destDir) {
  return new Promise((resolve, reject) => {
    // /usr/bin/unzip is built into macOS. The upstream asset is a
    // single-entry zip; `-o` overwrites the freshly-emptied staging dir
    // deterministically and `-q` keeps 144 MB of inflate chatter out of
    // the build log.
    const child = spawn('/usr/bin/unzip', ['-oq', archive, '-d', destDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', c => { stderr += String(c) })
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) resolve()
      else reject(new Error(`unzip exit ${code}: ${stderr.trim()}`))
    })
  })
}

main().catch(err => {
  process.stderr.write(
    `[fetch-opencode] ${err instanceof Error ? err.message : String(err)}\n`,
  )
  process.exit(1)
})
