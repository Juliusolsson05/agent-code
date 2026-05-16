import { access, copyFile, mkdir, readFile, readdir, stat } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Files staged into out/ that need to land inside the packaged app at
// runtime. Anything copied here MUST also be listed in
// electron-builder.yml `asarUnpack` if it has to be readable from a
// real filesystem path (executables and tar archives qualify; plain
// JSON could be read through the asar virtual FS but we keep the
// whole tree unpacked so the resolver doesn't have to branch).

const staticResources = [
  {
    // WHY this mirrors electron.vite.config.ts instead of using the historical
    // testing harness path:
    //
    // The addon is now a production proxy resource in claude-code-headless.
    // This script runs for packaged app staging, while the Vite plugin runs for
    // preview/dev main builds; both must copy the same source file or one path
    // will pass while the other ships a broken Claude proxy. Keeping the source
    // as `src/proxy/mitmAddon.py` also matches the package's own build script.
    from: 'packages/claude-code-headless/src/proxy/mitmAddon.py',
    to: 'out/main/mitmAddon.py',
  },
]

// WHY fileURLToPath and not `new URL(import.meta.url).pathname`:
//   URL.pathname keeps spaces percent-encoded — a contributor whose
//   checkout lives under e.g. `/Users/some user/Development/...` would
//   get `repoRoot = '/Users/some%20user/...'`, every subsequent
//   `fs/promises` call would ENOENT, the optional bundled-archive
//   copy would silently no-op (see the `if (!(await fileExists(...)))
//   continue` short-circuit below), and the packaged DMG would ship
//   without the bundled mitmproxy. fileURLToPath performs the
//   percent-decoding that filesystem APIs require. Pattern matches
//   `resolveAddonPath` in claude-code-headless' proxyServer.ts and
//   the sibling scripts under scripts/runtime-tools/*.mjs.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

for (const resource of staticResources) {
  const from = resolve(repoRoot, resource.from)
  const to = resolve(repoRoot, resource.to)
  await mkdir(dirname(to), { recursive: true })
  await copyFile(from, to)
}

// Bundled runtime tools — each lives under third_party/<tool>/ with a
// manifest.json and per-platform archives in cache/. We copy them
// into out/main/runtime/<tool>/ so that electron-builder's
// asarUnpack glob (out/main/runtime/**/*) lands them at a real
// filesystem path inside the packaged .app. The runtime resolver
// (src/main/setup/runtimeTools.ts) reads the manifest at startup and
// extracts the archive lazily on first use.
//
// WHY this is best-effort, not strict:
//   `npm run build:app` is invoked from many places — `npm run dev`
//   parents, contributor builds without a primed cache, etc. We do
//   not want a missing cache to break the dev build, because the
//   resolver gracefully falls back to PATH/Homebrew in that case.
//   Release builds run `npm run runtime:prepare:mac` first (strict +
//   --all), which guarantees the cache is populated. The release
//   path therefore catches missing artifacts; the dev path stays
//   forgiving.

const runtimeTools = [
  { id: 'mitmproxy', kind: 'tar.gz' },
  { id: 'tmux', kind: 'binary' },
]

for (const tool of runtimeTools) {
  const manifestSrc = resolve(repoRoot, 'third_party', tool.id, 'manifest.json')
  if (!(await fileExists(manifestSrc))) continue

  const manifest = JSON.parse(await readFile(manifestSrc, 'utf8'))
  const outDir = resolve(repoRoot, 'out', 'main', 'runtime', tool.id)
  await mkdir(outDir, { recursive: true })
  await copyFile(manifestSrc, join(outDir, 'manifest.json'))

  const cacheRoot = resolve(repoRoot, 'third_party', tool.id, 'cache')
  if (!(await fileExists(cacheRoot))) {
    console.warn(
      `[copy-packaged-resources] skipping ${tool.id} archives — ${cacheRoot} missing. ` +
        `Run \`npm run runtime:prepare:mac\` before \`npm run dist:mac\` for a release build.`,
    )
    continue
  }

  const platformDirs = await readdir(cacheRoot)
  for (const platform of platformDirs) {
    const platformSrc = join(cacheRoot, platform)
    const st = await stat(platformSrc).catch(() => null)
    if (!st?.isDirectory()) continue
    const platformOut = join(outDir, platform)
    await mkdir(platformOut, { recursive: true })
    for (const file of await readdir(platformSrc)) {
      // Skip partial downloads from interrupted fetches.
      if (file.endsWith('.partial')) continue
      await copyFile(join(platformSrc, file), join(platformOut, file))
    }
  }
}

async function fileExists(path) {
  try {
    await access(path, fsConstants.R_OK)
    return true
  } catch {
    return false
  }
}
