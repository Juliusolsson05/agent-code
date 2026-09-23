import { mkdtemp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { createPrivateClaudeMcpConfig, sweepStalePrivateMcpConfigs } from './builtInMcpLaunch.js'
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
  it('resolves a secret header into that server\'s own entry, never into Claude\'s environment', () => {
    // Review round 1: Claude hands its whole environment to every MCP child
    // and to the model's Bash tool, so the value must live only in the entry.
    const result = claudeUserMcpEntries([beeperHttp])
    expect(result.dropped).toEqual([])
    expect(result.entries).toEqual({
      beeper: { type: 'http', url: 'http://localhost:23373/v0/mcp', headers: { Authorization: `Bearer ${TOKEN}` } },
    })
    expect(result).not.toHaveProperty('env')
  })

  it('keeps literal env values and the server-expanded args of a stdio server', () => {
    const { entries } = claudeUserMcpEntries([beeperStdio])
    expect(entries['beeper-stdio']).toEqual({
      command: 'npx',
      args: ['-y', '@beeper/mcp-remote', '--header', 'Authorization: Bearer ${ACCESS_TOKEN}'],
      env: { ACCESS_TOKEN: TOKEN, LOG_LEVEL: 'info' },
    })
  })

  it('drops a server whose env or header names would break Codex -c paths', () => {
    const dotted: ResolvedUserMcpServer = { id: 'd', name: 'java', entry: { command: 'x', env: { 'java.home': '/opt' } }, secrets: {} }
    expect(claudeUserMcpEntries([dotted]).dropped[0]?.reason).toMatch(/java\.home/)
    const args: string[] = []
    expect(addCodexUserMcpLaunchConfig([dotted], args, {})[0]?.reason).toMatch(/java\.home/)
    expect(args).toEqual([])
  })

  it('drops a server whose secret is missing instead of emitting an empty credential', () => {
    const { entries, dropped } = claudeUserMcpEntries([{ ...beeperHttp, secrets: {} }])
    expect(entries).toEqual({})
    expect(dropped).toEqual([{ name: 'beeper', reason: 'A secret is not set' }])
  })

  it('writes one private file containing both built-in and user servers', async () => {
    const { entries } = claudeUserMcpEntries([beeperHttp])
    const config = await createPrivateClaudeMcpConfig(
      [{ name: 'agent_code', url: 'http://127.0.0.1:1/mcp', headers: {}, bearerToken: 'builtin' }],
      entries,
    )
    try {
      const text = await readFile(config!.path, 'utf8')
      expect(Object.keys(JSON.parse(text).mcpServers)).toEqual(['beeper', 'agent_code'])
      // The file is private (0600, removed on stop, swept after a crash).
      expect((await stat(config!.path)).mode & 0o777).toBe(0o600)
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
    const variable = userMcpSecretVariable('beeper', 'Authorization')
    expect(args).toEqual([
      '--config', 'mcp_servers.beeper.url="http://localhost:23373/v0/mcp"',
      '--config', `mcp_servers.beeper.env_http_headers.Authorization="${variable}"`,
      // Review round 1: Codex model shells inherit the full environment, so
      // every secret-bearing variable is excluded from them.
      '--config', 'shell_environment_policy.filters.AGENT_CODE_USER_MCP_*="exclude"',
    ])
    expect(env).toEqual({ [variable]: `Bearer ${TOKEN}` })
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
      '--config', 'shell_environment_policy.filters.ACCESS_TOKEN="exclude"',
    ])
    expect(env).toEqual({ ACCESS_TOKEN: TOKEN })
    expect(args.join(' ')).not.toContain(TOKEN)
  })

  it('drops SSE servers and secrets that would overwrite Codex\'s own environment', () => {
    expect(addCodexUserMcpLaunchConfig([
      { id: 'px', name: 'proxied', entry: { command: 'x', env: { HTTPS_PROXY: '${input:p}' } }, secrets: { p: 'http://corp' } },
    ], [], {})[0]?.name).toBe('proxied')
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
  it('is stable for the same server and key', () => {
    expect(userMcpSecretVariable('beeper', 'Authorization')).toBe(userMcpSecretVariable('beeper', 'Authorization'))
    expect(userMcpSecretVariable('beeper', 'Authorization')).toMatch(/^AGENT_CODE_USER_MCP_BEEPER_AUTHORIZATION_[0-9A-F]{10}$/)
  })

  it('never gives two different (server, key) pairs the same variable (review round 1)', () => {
    // These folded to the same name before the hash suffix, sending one
    // server's token to the other server's host.
    expect(userMcpSecretVariable('linear', 'X-Api-Key')).not.toBe(userMcpSecretVariable('linear-x', 'Api-Key'))
    expect(userMcpSecretVariable('gh', 'k')).not.toBe(userMcpSecretVariable('_gh', 'k'))
  })
})

describe('Codex shell exclusion styles', () => {
  it('re-sends the user\'s legacy exclude list together with ours, since a -c array replaces it', () => {
    const args: string[] = []
    addCodexUserMcpLaunchConfig([beeperHttp], args, {}, { style: 'legacy', exclude: ['MY_SECRET'] })
    expect(args.at(-1)).toBe('shell_environment_policy.exclude=["MY_SECRET","AGENT_CODE_USER_MCP_*"]')
    expect(args.join(' ')).not.toContain('shell_environment_policy.filters')
  })

  it('adds nothing to the shell policy when no secret is carried', () => {
    const args: string[] = []
    addCodexUserMcpLaunchConfig([{ id: 'p', name: 'plain', entry: { command: 'x', env: { LOG_LEVEL: 'info' } }, secrets: {} }], args, {})
    expect(args.join(' ')).not.toContain('shell_environment_policy')
  })
})

describe('sweepStalePrivateMcpConfigs', () => {
  it('removes a crashed run\'s private configs but keeps live ones', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sweep-'))
    try {
      await mkdir(join(dir, `agent-code-mcp-${process.pid}-live`))
      await mkdir(join(dir, 'agent-code-mcp-2147483646-dead'))
      await mkdir(join(dir, 'agent-code-mcp-legacyXYZ'))
      await mkdir(join(dir, 'unrelated'))
      expect(await sweepStalePrivateMcpConfigs(dir)).toBe(2)
      expect((await readdir(dir)).sort()).toEqual([`agent-code-mcp-${process.pid}-live`, 'unrelated'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})


describe('review round 2 Codex launch rules', () => {
  const mk = (name: string, env: Record<string, string>, secrets: Record<string, string>): ResolvedUserMcpServer =>
    ({ id: name, name, entry: { command: name, env }, secrets })

  it('never emits two shell filters that differ only in case (Codex rejects them)', () => {
    const args: string[] = []
    const dropped = addCodexUserMcpLaunchConfig([
      mk('a', { GITHUB_TOKEN: '${input:t}' }, { t: 'v' }),
      mk('b', { github_token: '${input:t}' }, { t: 'v' }),
    ], args, {})
    const filters = args.filter(arg => arg.startsWith('shell_environment_policy.filters.'))
    expect(new Set(filters.map(filter => filter.toUpperCase())).size).toBe(filters.length)
    expect(dropped.length + filters.length).toBeGreaterThan(0)
  })

  it('refuses to silently replace the user\'s own variable with a different value', () => {
    const env: Record<string, string> = { GITHUB_TOKEN: 'users-own' }
    const dropped = addCodexUserMcpLaunchConfig([mk('gh', { GITHUB_TOKEN: '${input:t}' }, { t: 'other' })], [], env)
    expect(dropped[0]?.reason).toMatch(/Your environment already sets GITHUB_TOKEN/)
    expect(env.GITHUB_TOKEN).toBe('users-own')
  })

  it('does not hide the user\'s own identical variable from model shells', () => {
    const args: string[] = []
    addCodexUserMcpLaunchConfig([mk('gh', { GITHUB_TOKEN: '${input:t}' }, { t: 'same' })], args, { GITHUB_TOKEN: 'same' })
    expect(args.join(' ')).not.toContain('shell_environment_policy')
  })
})
