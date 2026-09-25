// Where the Pi bridge extension lives on disk, for `pi -e <path>`.
//
// WHY a raw .ts file under out/main/runtime/pi/: pi loads the bridge itself
// (through its own jiti), inside the user's pi process, so it must never be
// part of Agent Code's bundle. electron.vite.config.ts and
// scripts/copy-packaged-resources.mjs both stage it at
// out/main/runtime/pi/bridge.ts, beside the main bundle (out/main/index.js).
//
// WHY resolved from this module's own URL and not Electron's app path: the
// provider runtime graph deliberately does not import 'electron' (tests load
// it under plain Node). Once bundled, this code runs from out/main/, so the
// staged file is `<dir of the bundle>/runtime/pi/bridge.ts` — the same
// "resource beside the main bundle" rule claude-code-headless uses for
// mitmAddon.py. fileURLToPath, not URL.pathname: packaged apps live under
// paths with spaces ("Agent Code.app").
//
// In a packaged app the bundle sits inside app.asar, but anything under
// out/main/runtime/** is asarUnpack'ed to app.asar.unpacked — the only copy pi
// (a separate process) can open. The `.asar/` → `.asar.unpacked/` swap is the
// one runtimeTools.unpackAsarPath performs; duplicated as one line because
// importing runtimeTools would pull Electron into this graph.
//
// The submodule source is the fallback (unit/system tests, a dev tree where
// the copy has not run): it is the identical file, the staging is a copy.

import { existsSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

function unpackAsar(path: string): string {
  return path.includes(`.asar${sep}`) ? path.replace(`.asar${sep}`, `.asar.unpacked${sep}`) : path
}

export function resolvePiBridgeScript(options: { moduleDir?: string; repoRoot?: string } = {}): string {
  const moduleDir = options.moduleDir ?? dirname(fileURLToPath(import.meta.url))
  const staged = unpackAsar(join(moduleDir, 'runtime', 'pi', 'bridge.ts'))
  if (existsSync(staged)) return staged
  return resolve(options.repoRoot ?? process.cwd(), 'packages', 'pi-terminal-headless', 'src', 'bridge', 'extension.ts')
}
