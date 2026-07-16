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
