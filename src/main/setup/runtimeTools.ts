// Runtime-tools resolver — the single place in main that knows how to
// find bundled third-party executables we ship with packaged Agent
// Code. Currently wired for:
//
//   - 'mitmdump' (from mitmproxy) — Claude proxy streaming, issue #119
//   - 'tmux'                       — terminal pane persistence,   issue #120 (stub)
//
// WHY this module exists:
//   We need exactly one source of truth for "where does the bundled
//   helper live on this platform?", and it must NOT leak Electron app
//   paths (process.resourcesPath, app.asar.unpacked, app.getPath
//   ('userData')) into reusable packages like claude-code-headless or
//   the TmuxRegistry. Those packages just receive a resolved
//   `mitmDumpPath` / `tmuxBinary` string. The Electron-aware resolution
//   logic stays here.
//
// API contract (stable across PR 1 -> PR 2 -> PR 3):
//
//   isBundledArchiveAvailable(tool): Promise<boolean>
//     Cheap check used by the setup gate — true iff the bundled
//     archive exists on disk for the current platform. Does NOT
//     extract anything.
//
//   resolveBundledTool(tool): Promise<string | null>
//     Returns an absolute filesystem path to a spawnable executable,
//     extracting the archive lazily on first call if needed. Returns
//     null when no bundled artifact is available for the current
//     platform/arch. Callers fall back to setup-cached / PATH lookup.
//
//   getPlatformKey(): string | null
//     Returns the manifest platform key for the current process, e.g.
//     'darwin-arm64'. Used here AND by scripts/runtime-tools/* so the
//     lookup convention has exactly one source of truth.
//
// Resolution order for any caller using a bundled tool (callers
// implement steps 1, 3, 4, 5 themselves; this module owns step 2):
//
//   1. caller-provided env override (tool-specific, e.g. CLAUDE_HEADLESS_MITMDUMP)
//   2. bundled runtime artifact (this module)
//   3. setup-cached path (@main/setup/toolchain.getToolPath)
//   4. PATH lookup
//   5. typed error with diagnostics

import { spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import {
  access,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { join, sep } from 'node:path'

import { app } from 'electron'

export type BundledToolId = 'mitmdump' | 'tmux'

type MitmproxyManifest = {
  tool: 'mitmproxy'
  version: string
  urlBase: string
  archiveFormat: 'tar.gz'
  executableInsideArchive: string
  platforms: Record<
    string,
    { filename: string; sha256: string; bytes?: number }
  >
}

// In-process per-version mutex. Two ClaudeSession spawns can race the
// resolver during a startup burst; without this they would both
// attempt to `tar -xzf` into the same target directory, racing each
// other through file creation. The first caller does the extraction;
// every subsequent caller reuses the same promise and returns the
// same path. Once the work completes (success or failure) we drop the
// entry so a later corruption doesn't permanently poison the slot.
const runtimeInstallLocks = new Map<string, Promise<string | null>>()

export function getPlatformKey(): string | null {
  // WHY mapping process.arch -> manifest arch lives ONLY here:
  //   Node's `process.arch` reports `x64` but mitmproxy upstream
  //   filenames use `x86_64`. Our manifest follows upstream so URL
  //   templating works directly. Single mapping ensures the
  //   convention has exactly one source of truth shared between this
  //   resolver and scripts/runtime-tools/*.mjs.
  const arch =
    process.arch === 'x64'
      ? 'x86_64'
      : process.arch === 'arm64'
        ? 'arm64'
        : null
  if (!arch) return null
  if (process.platform === 'darwin') return `darwin-${arch}`
  // Linux / Windows support is future work. Returning null makes
  // callers gracefully fall back to setup-cached / PATH lookup.
  return null
}

/**
 * Cheap "do we ship a bundled archive for this tool on this platform"
 * check. Used by the setup gate so it can hide the install prompt
 * without paying the cost of extracting the .app on every check.
 *
 * Side-effect free except for the disk reads on the manifest +
 * archive paths.
 */
export async function isBundledArchiveAvailable(
  tool: BundledToolId,
): Promise<boolean> {
  if (tool !== 'mitmdump') return false
  const platformKey = getPlatformKey()
  if (!platformKey) return false
  const manifest = await loadMitmproxyManifest()
  if (!manifest) return false
  const platform = manifest.platforms[platformKey]
  if (!platform) return false
  const archivePath = mitmproxyArchivePath(manifest, platformKey, platform)
  return fileExists(archivePath)
}

/**
 * Resolve the absolute path to a bundled runtime tool's spawnable
 * executable, extracting the archive lazily on first call if needed.
 * Returns null when no bundled artifact exists for the current
 * platform/arch.
 *
 * PR 2 wires mitmdump end-to-end here. PR 3 will branch on `tool` and
 * route 'tmux' to a sibling single-binary copy path.
 */
export async function resolveBundledTool(
  tool: BundledToolId,
): Promise<string | null> {
  if (tool === 'mitmdump') return resolveMitmdump()
  return null
}

async function resolveMitmdump(): Promise<string | null> {
  const platformKey = getPlatformKey()
  if (!platformKey) return null

  const manifest = await loadMitmproxyManifest()
  if (!manifest) return null
  const platform = manifest.platforms[platformKey]
  if (!platform) return null

  const lockKey = `mitmproxy-${manifest.version}-${platformKey}`
  const inFlight = runtimeInstallLocks.get(lockKey)
  if (inFlight) return inFlight

  const work = installMitmproxy(manifest, platformKey, platform)
  runtimeInstallLocks.set(lockKey, work)
  try {
    return await work
  } finally {
    runtimeInstallLocks.delete(lockKey)
  }
}

async function installMitmproxy(
  manifest: MitmproxyManifest,
  platformKey: string,
  platform: MitmproxyManifest['platforms'][string],
): Promise<string | null> {
  const installDir = join(
    app.getPath('userData'),
    'runtime',
    `mitmproxy-${manifest.version}`,
  )
  const finalExe = join(installDir, manifest.executableInsideArchive)
  const marker = join(installDir, '.installed')

  // Fast path: already extracted on a prior launch. The marker is
  // written last during extraction, so its presence guarantees the
  // full bundle is in place.
  if ((await fileExists(marker)) && (await isExecutable(finalExe))) {
    return finalExe
  }

  const archivePath = mitmproxyArchivePath(manifest, platformKey, platform)
  if (!(await fileExists(archivePath))) return null

  try {
    await mkdir(installDir, { recursive: true })
    await extractTarGz(archivePath, installDir)
    if (!(await isExecutable(finalExe))) return null
    // Marker is the LAST thing written. A crash mid-extract leaves
    // no marker, so the next launch re-extracts cleanly instead of
    // trusting a half-populated directory.
    await writeFile(
      marker,
      `${manifest.version}\n${new Date().toISOString()}\n`,
    )
    // Best-effort cleanup of stale versions so the runtime/ directory
    // does not grow by ~87 MB on every mitmproxy bump.
    void cleanupOldMitmproxyVersions(manifest.version)
    return finalExe
  } catch (err) {
    console.warn('[runtimeTools] mitmdump install failed:', err)
    return null
  }
}

async function loadMitmproxyManifest(): Promise<MitmproxyManifest | null> {
  const manifestPath = unpackAsarPath(
    join(app.getAppPath(), 'out', 'main', 'runtime', 'mitmproxy', 'manifest.json'),
  )
  try {
    const text = await readFile(manifestPath, 'utf8')
    return JSON.parse(text) as MitmproxyManifest
  } catch {
    // Manifest missing means either:
    //  - the build did not run `copy-packaged-resources.mjs` (dev mode
    //    without a prior `npm run build:app`), or
    //  - the cache was never populated.
    // Either way, return null so the caller falls back to PATH/setup.
    return null
  }
}

function mitmproxyArchivePath(
  manifest: MitmproxyManifest,
  platformKey: string,
  platform: MitmproxyManifest['platforms'][string],
): string {
  const filename = platform.filename.replaceAll('{version}', manifest.version)
  return unpackAsarPath(
    join(
      app.getAppPath(),
      'out',
      'main',
      'runtime',
      'mitmproxy',
      platformKey,
      filename,
    ),
  )
}

// In packaged builds, the app code lives under
// <resources>/app.asar/... but anything listed in `asarUnpack` is
// mirrored to <resources>/app.asar.unpacked/... and is the only path
// that resolves to a real filesystem location. Reading manifests and
// spawning executables both require the unpacked path. In dev there
// is no `.asar` segment and the swap is a no-op.
function unpackAsarPath(p: string): string {
  return p.includes(`.asar${sep}`)
    ? p.replace(`.asar${sep}`, `.asar.unpacked${sep}`)
    : p
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

function extractTarGz(archive: string, destDir: string): Promise<void> {
  // Spawning system /usr/bin/tar is intentional. mitmproxy's macOS
  // archive uses standard gzip-compressed tar — no extended POSIX
  // attributes that node-tar handles better than BSD tar — and
  // shelling out keeps Agent Code free of a tar dependency just for
  // this one path. macOS ships tar by default; if it is missing the
  // user has bigger problems than Claude proxy streaming.
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/tar', ['-xzf', archive, '-C', destDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) resolve()
      else reject(new Error(`tar exit ${code}: ${stderr.trim()}`))
    })
  })
}

async function cleanupOldMitmproxyVersions(
  currentVersion: string,
): Promise<void> {
  try {
    const root = join(app.getPath('userData'), 'runtime')
    const entries = await readdir(root).catch(() => [])
    for (const name of entries) {
      if (!name.startsWith('mitmproxy-')) continue
      if (name === `mitmproxy-${currentVersion}`) continue
      await rm(join(root, name), { recursive: true, force: true }).catch(
        () => {},
      )
    }
  } catch {
    // best effort
  }
}
