import { readFile, stat } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import {
  addCodexBuiltInMcpLaunchConfig,
  createPrivateClaudeMcpConfig,
} from './builtInMcpLaunch.js'

const secret = 'session-secret-that-must-not-enter-argv'
const server = {
  name: 'agent_code',
  url: 'http://127.0.0.1:1234/mcp',
  bearerToken: secret,
  headers: {},
}

describe('built-in MCP provider launch configuration', () => {
  it('passes Codex header values through environment-backed configuration', () => {
    const args: string[] = []
    const env: Record<string, string> = {}

    addCodexBuiltInMcpLaunchConfig([server], args, env)

    expect(args.join(' ')).not.toContain(secret)
    expect(args.join(' ')).toContain('env_http_headers.Authorization')
    expect(Object.values(env)).toContain(`Bearer ${secret}`)
  })

  it('passes Claude a private file path instead of inline secret JSON', async () => {
    const config = await createPrivateClaudeMcpConfig([server])
    expect(config).not.toBeNull()
    if (!config) return
    try {
      expect(config.path).not.toContain(secret)
      expect((await stat(config.path)).mode & 0o777).toBe(0o600)
      expect(await readFile(config.path, 'utf8')).toContain(`Bearer ${secret}`)
    } finally {
      await config.dispose()
    }
    await expect(readFile(config.path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
