import { rm } from 'node:fs/promises'
import { join } from 'node:path'

// electron-builder stages `out/` once, then reuses it for both thin Mac
// targets. That staging tree intentionally contains both runtime architectures
// so either target can be built, but leaving both in every finished .app ships
// ~75 MB of unreachable mitmproxy/cloudflared/tmux payload. afterPack is the
// first hook that knows the concrete target architecture and still runs before
// signing, so removing the other slice here produces honest thin artifacts
// without mutating the shared source staging tree or invalidating signatures.

const ELECTRON_BUILDER_ARCH = {
  0: 'ia32',
  1: 'x64',
  2: 'armv7l',
  3: 'arm64',
  4: 'universal',
}

export default async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return

  const arch =
    typeof context.arch === 'string'
      ? context.arch
      : ELECTRON_BUILDER_ARCH[context.arch]
  const keep = arch === 'arm64' ? 'darwin-arm64' : arch === 'x64' ? 'darwin-x86_64' : null
  if (!keep) {
    throw new Error(`Unsupported macOS packaging architecture: ${String(context.arch)}`)
  }

  const runtimeRoot = join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    'Contents',
    'Resources',
    'app.asar.unpacked',
    'out',
    'main',
    'runtime',
  )
  const remove = keep === 'darwin-arm64' ? 'darwin-x86_64' : 'darwin-arm64'
  for (const tool of ['mitmproxy', 'tmux', 'cloudflared']) {
    await rm(join(runtimeRoot, tool, remove), { recursive: true, force: true })
  }
}
