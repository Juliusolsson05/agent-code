import { constants } from 'node:fs'
import { open, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { EXTERNAL_OPERATOR_SERVER_NAME } from '@providers/shared/runtime/externalControlExclusion.js'
import { asRecord } from '@shared/lib/asRecord.js'

const missing = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')

function verificationError(path: string) {
  // JSON.parse errors and several filesystem errors include the malformed
  // source, which could contain credentials. Only the path reaches the UI.
  return new Error(`Could not verify Antigravity configuration at ${path}. Review this file before opening a managed Antigravity session.`)
}

export async function readAntigravityConfig(path: string): Promise<Record<string, unknown> | null> {
  let file
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
    if (!(await file.stat()).isFile()) throw verificationError(path)
    const text = await file.readFile('utf8')
    // agy accepts // comments. Preserve slashes and escaped quotes inside
    // JSON strings, including user-supplied server URLs and arguments.
    const json = text.replace(/"(?:\\.|[^"\\])*"|\/\/[^\r\n]*/g, token => token.startsWith('//') ? '' : token)
    // A fresh agy install can create a zero-byte file. The CLI reports
    // 'No MCP servers configured' for that state.
    if (!json.trim()) return {}
    const value = asRecord(JSON.parse(json))
    if (!value) throw verificationError(path)
    return value
  } catch (error) {
    if (missing(error)) return null
    throw verificationError(path)
  } finally { await file?.close() }
}

function reserved(name: string): boolean {
  return name.toLowerCase().replace(/_/g, '-') === EXTERNAL_OPERATOR_SERVER_NAME
}

function conflict(path: string) {
  return new Error(`Antigravity enables the external operator MCP server "${EXTERNAL_OPERATOR_SERVER_NAME}" in ${path}. Disable that entry for this profile before opening an Agent Code pane. Your configuration was left unchanged.`)
}

async function enabledOperator(path: string): Promise<boolean> {
  const config = await readAntigravityConfig(path)
  const servers = asRecord(config?.mcpServers)
  return Object.entries(servers ?? {}).some(([name, entry]) => reserved(name) && asRecord(entry)?.disabled !== true)
}

/** agy's additional workspace cannot shadow a running global MCP server.
 * A session permissions deny applies to TOOL USE; it still starts the server.
 * Refuse a conflicting launch before any agy code runs. This check is read-only,
 * independent of per-pane grants, and needs no shared or temporary override.
 * https://antigravity.google/docs/cli-settings */
export async function assertAntigravityExternalControlExcluded(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  paneServers: readonly { name: string }[] = [],
): Promise<void> {
  if (paneServers.some(entry => reserved(entry.name))) throw conflict('the pane configuration')
  const global = join(env.HOME || env.USERPROFILE || homedir(), '.gemini', 'config')
  for (const root of [global, join(cwd, '.agents')]) {
    const mcpPath = join(root, 'mcp_config.json')
    if (await enabledOperator(mcpPath)) throw conflict(mcpPath)

    const pluginsDir = join(root, 'plugins')
    let plugins
    try { plugins = await readdir(pluginsDir, { withFileTypes: true }) }
    catch (error) { if (missing(error)) continue; throw verificationError(pluginsDir) }
    for (const plugin of plugins) {
      if (!plugin.isDirectory() && !plugin.isSymbolicLink()) continue
      const path = join(pluginsDir, plugin.name, 'mcp_config.json')
      if (!await enabledOperator(path)) continue
      // agy 1.5.18's plugin disable writes plugins[folder].enabled=false
      // in the global config. The CLI keys it by folder, independent of the
      // display name inside plugin.json. Only skip a verified global disable.
      const config = root === global ? await readAntigravityConfig(join(global, 'config.json')) : null
      if (asRecord(asRecord(config?.plugins)?.[plugin.name])?.enabled !== false) throw conflict(path)
    }
  }
}
