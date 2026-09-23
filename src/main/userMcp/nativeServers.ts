import { access, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import TOML from '@iarna/toml'

import type { NativeMcpServerSource, UserMcpInput, UserMcpServerEntry } from '@shared/userMcp/types.js'
import { isPlainObject, isStringArray, isStringRecord, summarizeEntry, transportOf } from '@shared/userMcp/validate.js'

/**
 * Read-only view of the MCP servers each CLI loads from its OWN config
 * (spec Revision 2 §7). Agent Code never writes these files; it only reads
 * them to (a) show the user servers they would otherwise not know are loaded,
 * (b) offer Copy in, and (c) detect Codex name collisions before launch.
 *
 * Only user-scope files are listed. Project-scope files (`.mcp.json`,
 * `.codex/config.toml`) depend on an agent's cwd, which Settings does not have.
 */

export type NativeMcpPaths = {
  home: string
  claudeConfigDir?: string
  codexHome?: string
  platform: NodeJS.Platform
}

export function defaultNativeMcpPaths(): NativeMcpPaths {
  return {
    home: homedir(),
    claudeConfigDir: process.env.CLAUDE_CONFIG_DIR || undefined,
    codexHome: process.env.CODEX_HOME || undefined,
    platform: process.platform,
  }
}

// Mirrors Claude's getGlobalClaudeFile (vendor utils/env.ts): the user-scope
// file lives in CLAUDE_CONFIG_DIR when set, otherwise the home directory.
function claudeUserConfigFile(paths: NativeMcpPaths): string {
  return join(paths.claudeConfigDir || paths.home, '.claude.json')
}

function codexHome(paths: NativeMcpPaths): string {
  return paths.codexHome || join(paths.home, '.codex')
}

// Mirrors Claude's getManagedFilePath (vendor utils/settings/managedPath.ts).
function claudeManagedMcpFile(paths: NativeMcpPaths): string {
  const dir = paths.platform === 'darwin'
    ? '/Library/Application Support/ClaudeCode'
    : paths.platform === 'win32'
      ? 'C:\\Program Files\\ClaudeCode'
      : '/etc/claude-code'
  return join(dir, 'managed-mcp.json')
}

/**
 * When an enterprise managed-mcp.json exists, Claude takes exclusive control
 * of MCP and rejects any non-SDK `--mcp-config` server by exiting (vendor
 * main.tsx "enterprise MCP config"). User servers must then be held back for
 * Claude, or every Claude agent would fail to start.
 */
export async function claudeManagedMcpPolicyPresent(paths = defaultNativeMcpPaths()): Promise<boolean> {
  try {
    await access(claudeManagedMcpFile(paths))
    return true
  } catch {
    return false
  }
}

export async function readNativeMcpServers(paths = defaultNativeMcpPaths()): Promise<NativeMcpServerSource[]> {
  const [claude, codex] = await Promise.all([readClaudeNative(paths), readCodexNative(paths)])
  return [...claude, ...codex]
}

/**
 * Names Codex will already have in `mcp_servers` for an agent in `cwd`.
 *
 * WHY launch refuses these names for Codex: `-c mcp_servers.<n>.*` deep-merges
 * key by key into an existing table (codex-rs config/src/merge.rs). Our `url`
 * merged into a user's stdio table yields a mixed-transport entry that fails
 * config load and takes the WHOLE Codex launch down with it.
 */
export async function codexNativeServerNames(cwd: string, paths = defaultNativeMcpPaths()): Promise<Set<string>> {
  const names = new Set<string>()
  for (const file of await codexConfigLayers(cwd, paths)) {
    const table = await readCodexMcpTable(file)
    for (const name of Object.keys(table)) names.add(name)
  }
  return names
}

/**
 * The config.toml files Codex merges for an agent in `cwd`, lowest precedence
 * first: system, user (CODEX_HOME), then every `.codex/config.toml` from the
 * project root down to `cwd`.
 *
 * WHY the ancestor walk (review round 2): Codex's project discovery reads
 * every ancestor `.codex/config.toml` up to the project root marker (`.git`;
 * vendor codex-rs config/src/loader discover_project_layers), not just the
 * cwd's. Reading only `<cwd>/.codex` missed a repo-root server or legacy
 * shell policy for any agent started in a subdirectory or nested worktree —
 * and either one could make our `-c` overrides fail Codex's config load.
 * Managed and profile layers are not modelled; they are rare, and a miss
 * there degrades to the launch-time notice, not a silent change.
 */
export async function codexConfigLayers(cwd: string, paths = defaultNativeMcpPaths()): Promise<string[]> {
  const system = paths.platform === 'win32' ? [] : ['/etc/codex/config.toml']
  const ancestors: string[] = []
  let dir = cwd
  for (let depth = 0; depth < 64; depth++) {
    ancestors.unshift(join(dir, '.codex', 'config.toml'))
    if (await exists(join(dir, '.git'))) break
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return [...system, join(codexHome(paths), 'config.toml'), ...ancestors]
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * Which spelling the user's Codex config uses for shell-environment
 * exclusions, across the user and project config.toml (see
 * CodexShellPolicyStyle for why it decides how our exclusions are sent).
 * Legacy `exclude` entries are returned so they can be re-sent with ours,
 * because a `-c` array replaces the configured one instead of merging.
 */
export async function codexShellPolicyStyle(
  cwd: string,
  paths = defaultNativeMcpPaths(),
): Promise<{ style: 'filters' } | { style: 'legacy'; exclude: string[] }> {
  let legacy = false
  const exclude: string[] = []
  for (const file of await codexConfigLayers(cwd, paths)) {
    const policy = (await readCodexToml(file)).shell_environment_policy
    if (!isPlainObject(policy)) continue
    if (policy.exclude !== undefined || policy.include_only !== undefined) legacy = true
    // A later (project) layer replaces the array; keep the last one seen.
    if (isStringArray(policy.exclude)) exclude.splice(0, exclude.length, ...policy.exclude)
  }
  return legacy ? { style: 'legacy', exclude } : { style: 'filters' }
}

async function readClaudeNative(paths: NativeMcpPaths): Promise<NativeMcpServerSource[]> {
  const file = claudeUserConfigFile(paths)
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return []
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.mcpServers)) return []
  return Object.entries(parsed.mcpServers).map(([name, raw]) =>
    nativeServer('claude', name, displayPath(file, paths.home), isPlainObject(raw) ? raw : null))
}

async function readCodexNative(paths: NativeMcpPaths): Promise<NativeMcpServerSource[]> {
  const file = join(codexHome(paths), 'config.toml')
  const table = await readCodexMcpTable(file)
  return Object.entries(table).map(([name, raw]) =>
    nativeServer('codex', name, displayPath(file, paths.home), isPlainObject(raw) ? codexToMcpServersShape(raw) : null))
}

async function readCodexMcpTable(file: string): Promise<Record<string, unknown>> {
  const parsed = await readCodexToml(file)
  return isPlainObject(parsed.mcp_servers) ? parsed.mcp_servers : {}
}

async function readCodexToml(file: string): Promise<Record<string, unknown>> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return {}
  }
  try {
    return TOML.parse(text) as Record<string, unknown>
  } catch {
    // An unparseable config.toml also fails Codex itself; we have nothing
    // useful to add, so it contributes nothing rather than blocking launch.
    return {}
  }
}

/** Codex table → `mcpServers` entry, so Copy in can reuse the import path. */
function codexToMcpServersShape(raw: Record<string, unknown>): Record<string, unknown> {
  if (typeof raw.command === 'string') {
    const env: Record<string, string> = isStringRecord(raw.env) ? { ...raw.env } : {}
    // `env_vars` names pass through from Codex's own environment; in an
    // mcpServers entry that becomes an env value the user must supply.
    if (isStringArray(raw.env_vars)) for (const name of raw.env_vars) env[name] ??= ''
    return {
      command: raw.command,
      ...(isStringArray(raw.args) ? { args: raw.args } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
      ...(typeof raw.cwd === 'string' ? { cwd: raw.cwd } : {}),
    }
  }
  if (typeof raw.url === 'string') {
    const headers: Record<string, string> = isStringRecord(raw.http_headers) ? { ...raw.http_headers } : {}
    if (isStringRecord(raw.env_http_headers)) for (const header of Object.keys(raw.env_http_headers)) headers[header] ??= ''
    if (typeof raw.bearer_token_env_var === 'string') headers.Authorization ??= 'Bearer '
    return { type: 'http', url: raw.url, ...(Object.keys(headers).length > 0 ? { headers } : {}) }
  }
  return raw
}

function nativeServer(
  provider: 'claude' | 'codex',
  name: string,
  source: string,
  raw: Record<string, unknown> | null,
): NativeMcpServerSource {
  const transport = raw ? transportOf(raw) : null
  if (!raw || !transport) {
    return { provider, name, source, transport: null, summary: '', copyable: false, entry: null, inputs: [] }
  }
  const inputs: UserMcpInput[] = []
  const entry: Record<string, unknown> = { ...raw }
  // Withhold every value: native configs often store tokens in plaintext and
  // this object is sent to the renderer.
  for (const field of ['env', 'headers'] as const) {
    if (!isStringRecord(entry[field])) {
      delete entry[field]
      continue
    }
    const next: Record<string, string> = {}
    for (const [key, value] of Object.entries(entry[field] as Record<string, string>)) {
      const id = `${name}-${key}`.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 64)
      // The auth scheme word is not secret and keeping it means the user pastes
      // just the token. Codex's bearer_token_env_var arrives as "Bearer ".
      const scheme = /^(Bearer|Token|Basic)\s/i.exec(value)
      next[key] = scheme ? `${scheme[1]} \${input:${id}}` : `\${input:${id}}`
      inputs.push({ id, description: `${field === 'env' ? 'Environment variable' : 'Header'} ${key}` })
    }
    entry[field] = next
  }
  if (transport !== 'stdio') entry.type = transport
  return {
    provider,
    name,
    source,
    transport,
    summary: summarizeEntry(raw),
    copyable: true,
    entry: entry as UserMcpServerEntry,
    inputs,
  }
}

function displayPath(file: string, home: string): string {
  return file.startsWith(home) ? `~${file.slice(home.length)}` : file
}
