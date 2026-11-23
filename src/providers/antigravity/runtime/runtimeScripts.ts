// Where Antigravity's stdio MCP proxy lives on disk, and what runs it.
//
// WHY a real file and not bundled code: agy starts it itself, as the stdio MCP
// server Agent Code names in session/new, in a process of its own.
// electron.vite.config.ts and scripts/copy-packaged-resources.mjs stage it at
// out/main/runtime/antigravity/mcpProxy.mjs, beside the main bundle, and
// `out/main/runtime/**` is asarUnpack'ed so the packaged app hands agy a path
// a separate process can open. Resolution follows the Pi bridge resolver
// (providers/pi/runtime/bridgeScript.ts) exactly: this module's own URL (the
// provider runtime graph never imports 'electron'), the `.asar/` →
// `.asar.unpacked/` swap, and the in-repo package source as the fallback for
// tests and a dev tree where the copy has not run yet.

import { existsSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

function unpackAsar(path: string): string {
  return path.includes(`.asar${sep}`) ? path.replace(`.asar${sep}`, `.asar.unpacked${sep}`) : path
}

export function resolveAntigravityMcpProxyScript(options: { moduleDir?: string; repoRoot?: string } = {}): string {
  const moduleDir = options.moduleDir ?? dirname(fileURLToPath(import.meta.url))
  const staged = unpackAsar(join(moduleDir, 'runtime', 'antigravity', 'mcpProxy.mjs'))
  if (existsSync(staged)) return staged
  return resolve(options.repoRoot ?? process.cwd(), 'packages', 'antigravity-acp-headless', 'src', 'mcpProxy.mjs')
}

/**
 * The executable that runs the proxy: Agent Code's own binary (Electron in the
 * packaged app, switched to plain Node by ELECTRON_RUN_AS_NODE in the server's
 * env; Node itself under tests). WHY not a `node` from PATH: a GUI-launched
 * app's PATH often lacks one, and agy is a Go binary that brings none.
 */
export function resolveAntigravityScriptRunner(): string {
  return process.execPath
}
