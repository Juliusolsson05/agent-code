import { createHash } from 'node:crypto'

import { hasInputReference, substituteInputs } from '@shared/userMcp/inputs.js'
import type { ResolvedUserMcpServer, UserMcpDroppedServer } from '@shared/userMcp/types.js'
// CODEX_PROTECTED_ENV's WHY lives beside its definition in validate.ts.
import {
  CODEX_PROTECTED_ENV,
  isStringArray,
  isStringRecord,
  transportOf,
  USER_MCP_ENV_KEY_PATTERN,
  USER_MCP_HEADER_NAME_PATTERN,
} from '@shared/userMcp/validate.js'

export type { ResolvedUserMcpServer }

/** Prefix of every generated secret variable; also the shell-exclusion glob. */
export const USER_MCP_SECRET_VARIABLE_PREFIX = 'AGENT_CODE_USER_MCP_'

/**
 * Environment variable that carries one secret-bearing Codex header value.
 *
 * WHY deterministic from (server name, key) rather than an index: a stable
 * name keeps the launch config identical across launches, so nothing keyed on
 * it shifts when an unrelated server is toggled.
 *
 * WHY a hash suffix (review round 1): the readable part folds case and every
 * non-alphanumeric run to `_`, so `linear`+`X-Api-Key` and `linear-x`+`Api-Key`
 * both produced `…_LINEAR_X_API_KEY` and one server's token was sent to the
 * other server's host. The suffix is over the exact (name, key) pair, so
 * distinct pairs cannot collide while the name stays stable for the same pair.
 */
export function userMcpSecretVariable(serverName: string, key: string): string {
  const part = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  const digest = createHash('sha256').update(`${serverName}\0${key}`).digest('hex').slice(0, 10).toUpperCase()
  return `${USER_MCP_SECRET_VARIABLE_PREFIX}${part(serverName) || 'SERVER'}_${part(key) || 'VALUE'}_${digest}`
}

/**
 * Keys that cannot travel safely on either launcher. Codex splits `-c` key
 * paths on every '.', so a dotted env key or header name turns into a nested
 * table and fails config load for the WHOLE Codex launch (reproduced with
 * codex-cli in review round 1). Validation rejects these on save; this is the
 * launch-side fence for documents written by other builds or by hand.
 */
function invalidKey(entry: Record<string, unknown>): string | null {
  if (isStringRecord(entry.env)) {
    const bad = Object.keys(entry.env).find(key => !USER_MCP_ENV_KEY_PATTERN.test(key))
    if (bad !== undefined) return `Invalid environment variable name "${bad}"`
  }
  if (isStringRecord(entry.headers)) {
    const bad = Object.keys(entry.headers).find(key => !USER_MCP_HEADER_NAME_PATTERN.test(key))
    if (bad !== undefined) return `Invalid header name "${bad}"`
  }
  return null
}

/**
 * Claude `mcpServers` entries for the private `--mcp-config` file, with
 * secret values RESOLVED into the entry.
 *
 * WHY values go into the file and not Claude's environment (review round 1):
 * Claude launches every stdio MCP child, its Bash tool and hooks with its own
 * full environment (vendor services/mcp/client.ts `{...subprocessEnv(),
 * ...serverRef.env}`; subprocessEnv is unfiltered by default). A secret in
 * Claude's env therefore reached every third-party MCP server and any `env`
 * the model ran — and from there the transcript and the provider. In the file,
 * a stdio secret reaches only its own server's `env`, and a header only its
 * own server's requests. It is the file the built-in bearer already uses: mode
 * 0600 in a private temp directory, removed on stop and rollback, and swept at
 * startup if a crash left it behind (sweepStalePrivateMcpConfigs).
 *
 * Literal values and unknown keys pass through untouched: Claude's zod schemas
 * strip keys they do not know rather than rejecting them.
 */
export function claudeUserMcpEntries(servers: readonly ResolvedUserMcpServer[]): {
  entries: Record<string, Record<string, unknown>>
  dropped: UserMcpDroppedServer[]
} {
  const entries: Record<string, Record<string, unknown>> = {}
  const dropped: UserMcpDroppedServer[] = []
  for (const server of servers) {
    const transport = transportOf(server.entry)
    if (!transport) {
      dropped.push({ name: server.name, reason: 'Invalid server config' })
      continue
    }
    const entry: Record<string, unknown> = { ...server.entry }
    const keyProblem = invalidKey(entry)
    if (keyProblem) {
      dropped.push({ name: server.name, reason: keyProblem })
      continue
    }
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
        next[key] = resolved
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
  return { entries, dropped }
}

/**
 * How the user's own Codex config spells shell-environment exclusions, read by
 * main from the user and project config.toml.
 *
 * WHY it matters: Codex rejects a config that mixes the keyed `filters` table
 * with the legacy `exclude`/`include_only` arrays (verified against codex-cli:
 * it fails config load, so the whole launch). `filters` merges key by key
 * across layers, so we can ADD our exclusions without touching the user's; the
 * legacy array is replaced wholesale by a `-c` layer, so there we must re-send
 * the user's own entries together with ours.
 */
export type CodexShellPolicyStyle =
  | { style: 'filters' }
  | { style: 'legacy'; exclude: readonly string[] }

/**
 * Add Codex `-c mcp_servers.<name>.*` overrides for user servers.
 *
 * Why each field travels the way it does (argv is readable by any local
 * process and by our incident collectors; see builtInMcpLaunch.ts):
 *  - command/args/cwd/url: literal on argv. Validation already guarantees they
 *    contain no `${input:…}` secret.
 *  - stdio env, literal values: `env.<KEY>=` on argv, per server, so they
 *    never change Codex's own environment.
 *  - stdio env, secret values: set `KEY` in Codex's environment and list it in
 *    `env_vars`. Codex does no `${VAR}` expansion and `env_vars` cannot rename,
 *    so pass-through by the server's own variable name is the only secret-safe
 *    channel.
 *  - http headers (all of them): `env_http_headers.<H>="<generated var>"`,
 *    exactly like the built-in servers.
 *
 * Every variable that carries a secret is then EXCLUDED from Codex's model
 * shells via shell_environment_policy (review round 1): Codex's default policy
 * inherits the full environment with its KEY and TOKEN name filters off, so without
 * this an `echo $GITHUB_TOKEN` in any shell command printed the secret into
 * the transcript. MCP children are unaffected: they get only Codex's allowlist
 * plus their own `env_vars`.
 *
 * Returns servers that could not be attached; a dropped server never fails
 * the launch.
 */
export function addCodexUserMcpLaunchConfig(
  servers: readonly ResolvedUserMcpServer[],
  args: string[],
  env: Record<string, string>,
  shellPolicy: CodexShellPolicyStyle = { style: 'filters' },
): UserMcpDroppedServer[] {
  const dropped: UserMcpDroppedServer[] = []
  // Secret env names already claimed by an earlier server in this launch.
  const claimed = new Map<string, string>()
  const secretNames = new Set<string>()
  let generatedSecrets = false
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
    const keyProblem = invalidKey(server.entry as Record<string, unknown>)
    if (keyProblem) {
      dropped.push({ name: server.name, reason: keyProblem })
      continue
    }
    const serverArgs: string[] = []
    const serverEnv: Record<string, string> = {}
    const serverSecretNames: string[] = []
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
          serverSecretNames.push(key)
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
      if (key.startsWith(USER_MCP_SECRET_VARIABLE_PREFIX)) generatedSecrets = true
      else claimed.set(key, server.name)
    }
    for (const name of serverSecretNames) secretNames.add(name)
  }

  const excluded = [...(generatedSecrets ? [`${USER_MCP_SECRET_VARIABLE_PREFIX}*`] : []), ...secretNames]
  if (excluded.length > 0) {
    if (shellPolicy.style === 'legacy') {
      const merged = [...new Set([...shellPolicy.exclude, ...excluded])]
      args.push('--config', `shell_environment_policy.exclude=${JSON.stringify(merged)}`)
    } else {
      // Pattern keys contain no '.' (env names are validated), so the naive
      // `-c` path split is safe.
      for (const pattern of excluded) {
        args.push('--config', `shell_environment_policy.filters.${pattern}="exclude"`)
      }
    }
  }
  return dropped
}
