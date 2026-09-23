import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import { createPrivateClaudeMcpConfig } from './builtInMcpLaunch.js'
import {
  addCodexUserMcpLaunchConfig,
  claudeUserMcpEntries,
  userMcpSecretVariable,
  type ResolvedUserMcpServer,
} from './userMcpLaunch.js'

const TOKEN = 'bpr_live_9f3a1c'

// The Beeper Desktop HTTP server as it looks after importing its official
// snippet (https://developers.beeper.com/desktop-api/mcp/): the token has been
// lifted into a secret input and only the reference remains in the entry.
const beeperHttp: ResolvedUserMcpServer = {
  id: 'b1',
  name: 'beeper',
  entry: {
    type: 'http',
    url: 'http://localhost:23373/v0/mcp',
    headers: { Authorization: 'Bearer ${input:beeper-authorization}' },
  },
  secrets: { 'beeper-authorization': TOKEN },
}

// The official stdio alternative (`npx -y @beeper/mcp-remote`), where the
// server expands its own ${ACCESS_TOKEN} from the environment we give it.
const beeperStdio: ResolvedUserMcpServer = {
  id: 'b2',
  name: 'beeper-stdio',
  entry: {
    command: 'npx',
    args: ['-y', '@beeper/mcp-remote', '--header', 'Authorization: Bearer ${ACCESS_TOKEN}'],
    env: { ACCESS_TOKEN: '${input:beeper-access_token}', LOG_LEVEL: 'info' },
  },
  secrets: { 'beeper-access_token': TOKEN },
}

describe('claudeUserMcpEntries', () => {
  it('replaces secret header values with env references and moves the value to the environment', () => {
    const { entries, env, dropped } = claudeUserMcpEntries([beeperHttp])
    expect(dropped).toEqual([])
    expect(entries).toEqual({
      beeper: {
        type: 'http',
        url: 'http://localhost:23373/v0/mcp',
        headers: { Authorization: '${AGENT_CODE_USER_MCP_BEEPER_AUTHORIZATION}' },
      },
    })
    expect(env).toEqual({ AGENT_CODE_USER_MCP_BEEPER_AUTHORIZATION: `Bearer ${TOKEN}` })
  })

  it('keeps literal env values and the server-expanded args of a stdio server', () => {
    const { entries, env } = claudeUserMcpEntries([beeperStdio])
    expect(entries['beeper-stdio']).toEqual({
      command: 'npx',
      args: ['-y', '@beeper/mcp-remote', '--header', 'Authorization: Bearer ${ACCESS_TOKEN}'],
      env: { ACCESS_TOKEN: '${AGENT_CODE_USER_MCP_BEEPER_STDIO_ACCESS_TOKEN}', LOG_LEVEL: 'info' },
    })
    expect(env).toEqual({ AGENT_CODE_USER_MCP_BEEPER_STDIO_ACCESS_TOKEN: TOKEN })
  })

  it('drops a server whose secret is missing instead of emitting an empty credential', () => {
    const { entries, dropped } = claudeUserMcpEntries([{ ...beeperHttp, secrets: {} }])
    expect(entries).toEqual({})
    expect(dropped).toEqual([{ name: 'beeper', reason: 'A secret is not set' }])
  })

  it('writes one private file containing both built-in and user servers, and no secret', async () => {
    const { entries } = claudeUserMcpEntries([beeperHttp])
    const config = await createPrivateClaudeMcpConfig(
      [{ name: 'agent_code', url: 'http://127.0.0.1:1/mcp', headers: {}, bearerToken: 'builtin' }],
      entries,
    )
    try {
      const text = await readFile(config!.path, 'utf8')
      expect(Object.keys(JSON.parse(text).mcpServers)).toEqual(['beeper', 'agent_code'])
      expect(text).not.toContain(TOKEN)
    } finally {
      await config?.dispose()
    }
  })

  it('still creates the file when only user servers are attached', async () => {
    const config = await createPrivateClaudeMcpConfig([], claudeUserMcpEntries([beeperHttp]).entries)
    expect(config).not.toBeNull()
    await config?.dispose()
  })
})

describe('addCodexUserMcpLaunchConfig', () => {
  it('passes every HTTP header through env_http_headers so no token reaches argv', () => {
    const args: string[] = []
    const env: Record<string, string> = {}
    expect(addCodexUserMcpLaunchConfig([beeperHttp], args, env)).toEqual([])
    expect(args).toEqual([
      '--config', 'mcp_servers.beeper.url="http://localhost:23373/v0/mcp"',
      '--config', 'mcp_servers.beeper.env_http_headers.Authorization="AGENT_CODE_USER_MCP_BEEPER_AUTHORIZATION"',
    ])
    expect(env).toEqual({ AGENT_CODE_USER_MCP_BEEPER_AUTHORIZATION: `Bearer ${TOKEN}` })
    expect(args.join(' ')).not.toContain(TOKEN)
  })

  it('passes stdio secrets by name through env_vars and literals per server', () => {
    const args: string[] = []
    const env: Record<string, string> = {}
    expect(addCodexUserMcpLaunchConfig([beeperStdio], args, env)).toEqual([])
    expect(args).toEqual([
      '--config', 'mcp_servers.beeper-stdio.command="npx"',
      '--config', 'mcp_servers.beeper-stdio.args=["-y","@beeper/mcp-remote","--header","Authorization: Bearer ${ACCESS_TOKEN}"]',
      '--config', 'mcp_servers.beeper-stdio.env.LOG_LEVEL="info"',
      '--config', 'mcp_servers.beeper-stdio.env_vars=["ACCESS_TOKEN"]',
    ])
    expect(env).toEqual({ ACCESS_TOKEN: TOKEN })
    expect(args.join(' ')).not.toContain(TOKEN)
  })

  it('drops SSE servers and secrets that would overwrite Codex\'s own environment', () => {
    const args: string[] = []
    const dropped = addCodexUserMcpLaunchConfig([
      { id: 's', name: 'linear', entry: { type: 'sse', url: 'https://mcp.linear.app/sse' }, secrets: {} },
      { id: 'o', name: 'openai', entry: { command: 'x', env: { OPENAI_API_KEY: '${input:k}' } }, secrets: { k: 'v' } },
    ], args, {})
    expect(dropped.map(server => server.name)).toEqual(['linear', 'openai'])
    expect(args).toEqual([])
  })

  it('refuses a second server that needs the same env name with a different value', () => {
    const env: Record<string, string> = {}
    const mk = (name: string, value: string): ResolvedUserMcpServer => ({
      id: name, name, entry: { command: name, env: { GITHUB_TOKEN: '${input:t}' } }, secrets: { t: value },
    })
    const dropped = addCodexUserMcpLaunchConfig([mk('one', 'a'), mk('two', 'b'), mk('three', 'a')], [], env)
    expect(dropped).toEqual([{ name: 'two', reason: 'Secret GITHUB_TOKEN is already used with a different value by one' }])
    expect(env.GITHUB_TOKEN).toBe('a')
  })

  it('leaves no partial table behind for a server dropped half-way', () => {
    const args: string[] = []
    addCodexUserMcpLaunchConfig([{ ...beeperStdio, secrets: {} }], args, {})
    expect(args).toEqual([])
  })
})

describe('userMcpSecretVariable', () => {
  it('is stable for a server regardless of which other servers are attached', () => {
    expect(userMcpSecretVariable('beeper', 'Authorization')).toBe('AGENT_CODE_USER_MCP_BEEPER_AUTHORIZATION')
    expect(userMcpSecretVariable('my-server', 'X-Api-Key')).toBe('AGENT_CODE_USER_MCP_MY_SERVER_X_API_KEY')
  })
})
