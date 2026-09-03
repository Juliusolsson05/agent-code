import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { BuiltInMcpServerConfig } from '@mcp/shared/types.js'

export type PrivateMcpConfig = {
  path: string
  dispose(): Promise<void>
}

/**
 * Add Codex MCP overrides without putting credentials in its process argument list.
 *
 * WHY argv may contain the environment *name* but never its value: Codex natively supports
 * `env_http_headers`, and an inherited environment is cleared with the child process. The old
 * static `http_headers` override exposed bearer tokens to `ps`, incident collectors, and crash
 * diagnostics. Keeping every header value behind a generated variable also avoids having to
 * guess which future header names are sensitive.
 */
export function addCodexBuiltInMcpLaunchConfig(
  servers: readonly BuiltInMcpServerConfig[],
  args: string[],
  env: Record<string, string>,
): void {
  servers.forEach((server, serverIndex) => {
    const serverKey = tomlKeySegment(server.name)
    args.push('--config', `mcp_servers.${serverKey}.url=${JSON.stringify(server.url)}`)
    const headers = {
      ...server.headers,
      ...(server.bearerToken === undefined
        ? {}
        : { Authorization: `Bearer ${server.bearerToken}` }),
    }
    Object.entries(headers).forEach(([header, value], headerIndex) => {
      const variable = `AGENT_CODE_MCP_${serverIndex}_${headerIndex}`
      env[variable] = value
      args.push(
        '--config',
        `mcp_servers.${serverKey}.env_http_headers.${tomlKeySegment(header)}=${JSON.stringify(variable)}`,
      )
    })
  })
}

/**
 * Merge Agent Code's per-session HTTP MCP endpoints into OpenCode's highest-
 * precedence inline configuration.
 *
 * WHY use `OPENCODE_CONFIG_CONTENT` instead of editing a user config file:
 * these URLs and bearer tokens belong to one short-lived Agent Code session.
 * Persisting them would leave dead endpoints behind and, worse, copy session
 * credentials into durable user-owned state. OpenCode supports `{env:NAME}`
 * interpolation in config values, so the JSON carries only generated variable
 * names while the actual credentials stay in the child process environment.
 * This is the same process-inspection boundary Codex uses above: secrets do
 * not appear in argv or in the inline config value.
 *
 * Existing inline configuration is preserved because users commonly use this
 * variable to test unreleased OpenCode options. Agent Code's server names win
 * on collision: a built-in tool call must resolve to the endpoint whose token
 * SessionManager issued for this exact local session, never to a stale user
 * entry that happens to reuse the name.
 */
export function addOpencodeBuiltInMcpLaunchConfig(
  servers: readonly BuiltInMcpServerConfig[],
  env: Record<string, string>,
): void {
  if (servers.length === 0) return

  const existing = parseOpencodeInlineConfig(env.OPENCODE_CONFIG_CONTENT)
  const existingMcp = asPlainObject(existing.mcp, 'mcp')
  const builtInMcp: Record<string, unknown> = {}

  servers.forEach((server, serverIndex) => {
    const headers = {
      ...server.headers,
      ...(server.bearerToken === undefined
        ? {}
        : { Authorization: `Bearer ${server.bearerToken}` }),
    }
    const interpolatedHeaders: Record<string, string> = {}
    Object.entries(headers).forEach(([header, value], headerIndex) => {
      const variable = `AGENT_CODE_MCP_${serverIndex}_${headerIndex}`
      env[variable] = value
      interpolatedHeaders[header] = `{env:${variable}}`
    })
    builtInMcp[server.name] = {
      type: 'remote',
      url: server.url,
      enabled: true,
      ...(Object.keys(interpolatedHeaders).length > 0
        ? { headers: interpolatedHeaders }
        : {}),
    }
  })

  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    ...existing,
    mcp: {
      ...existingMcp,
      ...builtInMcp,
    },
  })
}

/**
 * Materialize Claude's MCP config in a mode-0600 temporary directory.
 *
 * WHY a file is preferable to Claude's supported inline JSON form: `--mcp-config` accepts both,
 * but inline JSON becomes argv and therefore leaks every bearer token. The file is retained until
 * the session stops because Claude is free to parse it after process creation; deleting it
 * immediately after `spawn` creates a startup race. Callers own `dispose()` on normal stop and on
 * every partial-start rollback.
 */
export async function createPrivateClaudeMcpConfig(
  servers: readonly BuiltInMcpServerConfig[],
): Promise<PrivateMcpConfig | null> {
  if (servers.length === 0) return null
  const directory = await mkdtemp(join(tmpdir(), 'agent-code-mcp-'))
  const path = join(directory, 'mcp.json')
  const document = {
    mcpServers: Object.fromEntries(servers.map(server => [
      server.name,
      {
        type: 'http',
        url: server.url,
        headers: {
          ...server.headers,
          ...(server.bearerToken === undefined
            ? {}
            : { Authorization: `Bearer ${server.bearerToken}` }),
        },
      },
    ])),
  }
  try {
    await writeFile(path, `${JSON.stringify(document)}\n`, { encoding: 'utf8', mode: 0o600 })
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
  return {
    path,
    async dispose() {
      await rm(directory, { recursive: true, force: true })
    },
  }
}

function tomlKeySegment(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : JSON.stringify(value)
}

function parseOpencodeInlineConfig(value: string | undefined): Record<string, unknown> {
  if (!value?.trim()) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch (error) {
    throw new Error(
      `Cannot add Agent Code MCP servers because OPENCODE_CONFIG_CONTENT is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  return asPlainObject(parsed, 'root')
}

function asPlainObject(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined) return {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(
      `Cannot add Agent Code MCP servers because OPENCODE_CONFIG_CONTENT ${field} must be an object`,
    )
  }
  return value as Record<string, unknown>
}
