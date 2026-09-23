import { hasInputReference, substituteInputs } from '@shared/userMcp/inputs.js'
import type { ResolvedUserMcpServer, UserMcpDroppedServer } from '@shared/userMcp/types.js'

export type { ResolvedUserMcpServer }
import { isStringArray, isStringRecord, transportOf } from '@shared/userMcp/validate.js'

/**
 * Environment variable that carries one secret-bearing env/header value.
 *
 * WHY deterministic from (server name, key) instead of an index like the
 * built-in launcher's `AGENT_CODE_MCP_i_j`: Claude keys a server's stored OAuth
 * tokens on `name|sha256({type,url,headers})` (vendor services/mcp/auth.ts),
 * and our headers contain these variable NAMES. An index would shift whenever
 * another server was toggled on or off, change the hash, and silently discard
 * the user's OAuth login for an unrelated server.
 */
export function userMcpSecretVariable(serverName: string, key: string): string {
  const part = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return `AGENT_CODE_USER_MCP_${part(serverName) || 'SERVER'}_${part(key) || 'VALUE'}`
}

/**
 * Claude `mcpServers` entries for the private `--mcp-config` file.
 *
 * Secret-bearing values become `${AGENT_CODE_USER_MCP_…}` references and the
 * substituted value goes into Claude's process environment; Claude expands
 * `${VAR}` in command/args/env/url/headers when it loads the file (vendor
 * services/mcp/envExpansion.ts). The file itself (mode 0600, deleted on stop)
 * therefore never contains a secret either. Literal values and unknown keys
 * pass through untouched: Claude's zod schemas strip keys they do not know
 * rather than rejecting them, and a README's `oauth` block is a key Claude
 * DOES know.
 */
export function claudeUserMcpEntries(servers: readonly ResolvedUserMcpServer[]): {
  entries: Record<string, Record<string, unknown>>
  env: Record<string, string>
  dropped: UserMcpDroppedServer[]
} {
  const entries: Record<string, Record<string, unknown>> = {}
  const env: Record<string, string> = {}
  const dropped: UserMcpDroppedServer[] = []
  for (const server of servers) {
    const transport = transportOf(server.entry)
    if (!transport) {
      dropped.push({ name: server.name, reason: 'Invalid server config' })
      continue
    }
    const entry: Record<string, unknown> = { ...server.entry }
    let missing = false
    for (const field of ['env', 'headers'] as const) {
      const record = entry[field]
      if (!isStringRecord(record)) continue
      const next: Record<string, string> = {}
      for (const [key, value] of Object.entries(record)) {
        if (!hasInputReference(value)) {
          next[key] = value
          continue
        }
        const resolved = substituteInputs(value, server.secrets)
        if (resolved === null) {
          missing = true
          break
        }
        const variable = userMcpSecretVariable(server.name, key)
        env[variable] = resolved
        next[key] = `\${${variable}}`
      }
      entry[field] = next
    }
    if (missing) {
      dropped.push({ name: server.name, reason: 'A secret is not set' })
      continue
    }
    // Explicit type keeps Claude's union parse unambiguous for remote entries;
    // stdio is valid with or without it.
    if (transport !== 'stdio') entry.type = transport
    entries[server.name] = entry
  }
  return { entries, env, dropped }
}

/**
 * Environment names Codex itself depends on. A user stdio server's secret has
 * to be placed in Codex's OWN environment (Codex forwards env to MCP children
 * only through an allowlist plus `env_vars` pass-through names, and `env_vars`
 * cannot rename), so a server asking for one of these would silently change how
 * Codex authenticates, finds binaries, or talks to our own MCP host.
 */
const CODEX_PROTECTED_ENV = /^(PATH|HOME|SHELL|USER|LOGNAME|TMPDIR|LANG|TERM|CODEX_.*|OPENAI_.*|AGENT_CODE_.*)$/

/**
 * Add Codex `-c mcp_servers.<name>.*` overrides for user servers.
 *
 * Why each field travels the way it does (argv is readable by any local
 * process and by our incident collectors; see builtInMcpLaunch.ts):
 *  - command/args/cwd/url: literal on argv. Validation already guarantees they
 *    contain no `${input:…}` secret.
 *  - stdio env, literal values: `env.<KEY>=` on argv. They are not secrets by
 *    the user's own choice, and passing them per-server avoids changing
 *    Codex's own environment.
 *  - stdio env, secret values: set `KEY` in Codex's environment and list it in
 *    `env_vars`. Codex does no `${VAR}` expansion, so pass-through by the
 *    server's own variable name is the only secret-safe channel.
 *  - http headers (all of them): `env_http_headers.<H>="<generated var>"`,
 *    exactly like the built-in servers. Codex rejects a literal
 *    `bearer_token`, and this covers `Authorization` without special casing.
 *
 * Returns servers that could not be attached; a dropped server never fails
 * the launch.
 */
export function addCodexUserMcpLaunchConfig(
  servers: readonly ResolvedUserMcpServer[],
  args: string[],
  env: Record<string, string>,
): UserMcpDroppedServer[] {
  const dropped: UserMcpDroppedServer[] = []
  // Secret env names already claimed by an earlier server in this launch.
  const claimed = new Map<string, string>()
  for (const server of servers) {
    const transport = transportOf(server.entry)
    if (!transport) {
      dropped.push({ name: server.name, reason: 'Invalid server config' })
      continue
    }
    if (transport === 'sse') {
      dropped.push({ name: server.name, reason: 'Codex does not support SSE servers' })
      continue
    }
    const serverArgs: string[] = []
    const serverEnv: Record<string, string> = {}
    const prefix = `mcp_servers.${server.name}`
    const set = (key: string, value: unknown) => serverArgs.push('--config', `${prefix}.${key}=${JSON.stringify(value)}`)
    let failure: string | null = null

    if (transport === 'stdio') {
      const entry = server.entry as Record<string, unknown>
      set('command', entry.command)
      if (isStringArray(entry.args) && entry.args.length > 0) set('args', entry.args)
      if (typeof entry.cwd === 'string' && entry.cwd) set('cwd', entry.cwd)
      const passThrough: string[] = []
      if (isStringRecord(entry.env)) {
        for (const [key, value] of Object.entries(entry.env)) {
          if (!hasInputReference(value)) {
            set(`env.${key}`, value)
            continue
          }
          const resolved = substituteInputs(value, server.secrets)
          if (resolved === null) {
            failure = 'A secret is not set'
            break
          }
          if (CODEX_PROTECTED_ENV.test(key)) {
            failure = `Codex cannot pass a secret named ${key} without changing its own environment`
            break
          }
          const owner = claimed.get(key)
          if (owner !== undefined && env[key] !== resolved) {
            failure = `Secret ${key} is already used with a different value by ${owner}`
            break
          }
          serverEnv[key] = resolved
          passThrough.push(key)
        }
      }
      if (passThrough.length > 0) set('env_vars', passThrough)
    } else {
      const entry = server.entry as Record<string, unknown>
      set('url', entry.url)
      if (isStringRecord(entry.headers)) {
        for (const [header, value] of Object.entries(entry.headers)) {
          const resolved = hasInputReference(value) ? substituteInputs(value, server.secrets) : value
          if (resolved === null) {
            failure = 'A secret is not set'
            break
          }
          const variable = userMcpSecretVariable(server.name, header)
          serverEnv[variable] = resolved
          set(`env_http_headers.${header}`, variable)
        }
      }
    }

    if (failure) {
      dropped.push({ name: server.name, reason: failure })
      continue
    }
    // Commit only after the whole server succeeded, so a server dropped
    // half-way leaves neither a partial `mcp_servers` table (which Codex would
    // reject as an invalid transport, failing the entire launch) nor stray
    // variables behind.
    args.push(...serverArgs)
    Object.assign(env, serverEnv)
    for (const key of Object.keys(serverEnv)) {
      if (!key.startsWith('AGENT_CODE_USER_MCP_')) claimed.set(key, server.name)
    }
  }
  return dropped
}
