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
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
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
 * Cheap "do we ship a bundled artifact for this tool on this platform"
 * check. Used by the setup gate so it can hide the install prompt
 * without paying the cost of any extraction work.
 *
 * Side-effect free except for the disk reads on the manifest +
 * artifact paths.
 */
export async function isBundledArchiveAvailable(
  tool: BundledToolId,
): Promise<boolean> {
  if (tool === 'mitmdump') {
    const platformKey = getPlatformKey()
    if (!platformKey) return false
    const manifest = await loadMitmproxyManifest()
    if (!manifest) return false
    const platform = manifest.platforms[platformKey]
    if (!platform) return false
    return fileExists(mitmproxyArchivePath(manifest, platformKey, platform))
  }
  if (tool === 'tmux') {
    const platformKey = getPlatformKey()
    if (!platformKey) return false
    const manifest = await loadTmuxManifest()
    if (!manifest) return false
    if (!manifest.platforms[platformKey]) return false
    return fileExists(tmuxBinaryPath(manifest, platformKey))
  }
  return false
}

/**
 * Resolve the absolute path to a bundled runtime tool's spawnable
 * executable. For tools shipped as multi-file archives (mitmdump),
 * extract lazily on first call. For single-binary tools (tmux), no
 * extraction is needed — we return the asar-unpacked path directly.
 * Returns null when no bundled artifact exists for the current
 * platform/arch.
 */
export async function resolveBundledTool(
  tool: BundledToolId,
): Promise<string | null> {
  if (tool === 'mitmdump') return resolveMitmdump()
  if (tool === 'tmux') return resolveTmux()
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

  // Atomic extract: untar into a sibling tmp directory, then rename
  // into place.
  //
  // WHY we don't extract straight into `installDir`:
  //   mitmproxy.app's PyInstaller layout contains symlinks (Python
  //   framework `Versions/3.X/Current` → `Current`, etc.). BSD
  //   `/usr/bin/tar -xzf` on top of a half-extracted directory can
  //   leave a mixed state — a regular file where a symlink should be,
  //   or vice versa — that the next launch then trusts because the
  //   marker check only proves "marker present", not "tree shape
  //   correct". The marker-last pattern stops us from trusting a
  //   half-extract, but it does NOT stop the half-extract from
  //   poisoning the next attempt. Extracting into a fresh tmp dir and
  //   atomically renaming on success means the canonical
  //   `mitmproxy-<ver>/` directory is only ever a fully-populated
  //   tree or absent. The rename is atomic on macOS because both
  //   paths live on the same volume (userData).
  const tmpDir = `${installDir}.tmp-${process.pid}-${Date.now()}`
  try {
    // Clear any leftover tmp from a previously-interrupted attempt.
    // Two same-process callers can't race here because the per-
    // version mutex in resolveMitmdump() serialises this whole block.
    await rm(tmpDir, { recursive: true, force: true })
    await mkdir(tmpDir, { recursive: true })
    await extractTarGz(archivePath, tmpDir)
    const tmpExe = join(tmpDir, manifest.executableInsideArchive)
    if (!(await isExecutable(tmpExe))) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
      return null
    }
    // Replace any existing install in one go: rm-rf the old dir
    // (could be a half-extracted leftover from a prior crash), then
    // rename our verified tmp dir into place.
    await rm(installDir, { recursive: true, force: true })
    await rename(tmpDir, installDir)
    // Marker is the LAST thing written. A crash before this point
    // either leaves no tmpDir (we cleaned it on failure) or a renamed
    // install dir with no marker; next launch sees no marker, drops
    // it, and re-extracts cleanly.
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
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    return null
  }
}

// ---------------------------------------------------------------------------
// tmux resolver
//
// WHY tmux's path looks nothing like mitmproxy's despite both being
// "bundled runtime tools":
//   tmux is a single 1.6 MB Mach-O that links only to system dylibs
//   guaranteed present on every macOS install (libSystem, libresolv —
//   verified with `otool -L`). There is no nested .app, no Python
//   framework, no PyInstaller symlinks. Once electron-builder
//   asarUnpack drops the binary at a real filesystem path, that path
//   is directly spawnable: there is nothing to "install" into
//   userData. So `resolveTmux` is a plain "find + chmod + return"
//   rather than the temp+rename+marker dance `resolveMitmdump` has to
//   do. Two different shapes for two different artifact kinds is
//   fine; the manifest schema and the public API stay identical.
//
// WHY we chmod defensively even though `copyFile` should preserve mode:
//   `fs.copyFile` preserves POSIX mode bits, and electron-builder's
//   asarUnpack pathway has not been observed to drop the exec bit on
//   our own builds. But this resolver is called once at app startup,
//   the cost is one syscall, and chmod-on-the-canonical-bundled-path
//   is the kind of safety net that's much easier to keep than to
//   re-add after a confusing "works in dev, broken in signed DMG"
//   bug report. If we ever measure this as hot, drop it; until
//   then, keep it cheap.
type TmuxManifest = {
  tool: 'tmux'
  version: string
  urlBase: string
  archiveFormat: 'tar.gz'
  executableInsideArchive: string
  platforms: Record<
    string,
    { filename: string; sha256: string; bytes?: number }
  >
}

async function resolveTmux(): Promise<string | null> {
  const platformKey = getPlatformKey()
  if (!platformKey) return null
  const manifest = await loadTmuxManifest()
  if (!manifest) return null
  if (!manifest.platforms[platformKey]) return null

  const binary = tmuxBinaryPath(manifest, platformKey)
  if (!(await fileExists(binary))) return null

  // chmod is cheap and idempotent; we don't bother caching whether
  // we've already done it for this process. Skipping the chmod when
  // the bit is already set would be a micro-optimization not worth
  // the extra stat.
  try {
    await chmod(binary, 0o755)
  } catch {
    // If chmod fails (read-only filesystem in some sandboxed test
    // environment?), fall through; the access check below will catch
    // a genuinely non-executable file.
  }
  if (!(await isExecutable(binary))) return null
  return binary
}

async function loadTmuxManifest(): Promise<TmuxManifest | null> {
  const manifestPath = unpackAsarPath(
    join(app.getAppPath(), 'out', 'main', 'runtime', 'tmux', 'manifest.json'),
  )
  try {
    const text = await readFile(manifestPath, 'utf8')
    return JSON.parse(text) as TmuxManifest
  } catch {
    return null
  }
}

function tmuxBinaryPath(
  manifest: TmuxManifest,
  platformKey: string,
): string {
  return unpackAsarPath(
    join(
      app.getAppPath(),
      'out',
      'main',
      'runtime',
      'tmux',
      platformKey,
      manifest.executableInsideArchive,
    ),
  )
}

// ---------------------------------------------------------------------------
// mitmproxy helpers (below)

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
  // KNOWN LIMITATION: this cleanup is same-userData, best-effort,
  // with no cross-process lock. If two Agent Code installs (e.g. a
  // packaged production app + a `npm run start` dev instance pointed
  // at different bundled mitmproxy versions) share one userData
  // directory, the newer build will rm-rf the older build's runtime
  // dir on its first proxy session. The outcome is wasted I/O on the
  // older build's next session (it just re-extracts from its own
  // bundled archive), not data loss or a broken running session — a
  // live mitmdump process keeps running fine after its on-disk image
  // is unlinked, per Unix open-file semantics. We will add a per-
  // userData advisory lock if this surfaces in practice; v1 ships
  // without it because the multi-version scenario is unusual.
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
