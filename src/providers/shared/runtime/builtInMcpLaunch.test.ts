import { describe, expect, it } from 'vitest'

import { addOpencodeBuiltInMcpLaunchConfig } from './builtInMcpLaunch.js'

describe('addOpencodeBuiltInMcpLaunchConfig', () => {
  it('merges remote servers while keeping credentials out of inline JSON', () => {
    const env: Record<string, string> = {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        model: 'example/model',
        mcp: { personal: { type: 'remote', url: 'https://example.test/mcp' } },
      }),
    }

    addOpencodeBuiltInMcpLaunchConfig(
      [{
        name: 'agent-code',
        url: 'http://127.0.0.1:4200/session/test',
        bearerToken: 'session-secret',
        headers: { 'X-Agent-Code': 'header-secret' },
      }],
      env,
    )

    expect(env.OPENCODE_CONFIG_CONTENT).not.toContain('session-secret')
    expect(env.OPENCODE_CONFIG_CONTENT).not.toContain('header-secret')
    expect(env.AGENT_CODE_MCP_0_0).toBe('header-secret')
    expect(env.AGENT_CODE_MCP_0_1).toBe('Bearer session-secret')
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT)).toEqual({
      model: 'example/model',
      mcp: {
        personal: { type: 'remote', url: 'https://example.test/mcp' },
        'agent-code': {
          type: 'remote',
          url: 'http://127.0.0.1:4200/session/test',
          enabled: true,
          headers: {
            'X-Agent-Code': '{env:AGENT_CODE_MCP_0_0}',
            Authorization: '{env:AGENT_CODE_MCP_0_1}',
          },
        },
      },
    })
  })

  it('does not mutate the environment when no servers are requested', () => {
    const env = { OPENCODE_CONFIG_CONTENT: '{not-json' }
    addOpencodeBuiltInMcpLaunchConfig([], env)
    expect(env).toEqual({ OPENCODE_CONFIG_CONTENT: '{not-json' })
  })

  it('fails before spawn when existing inline configuration cannot be merged safely', () => {
    expect(() => addOpencodeBuiltInMcpLaunchConfig(
      [{
        name: 'agent-code',
        url: 'http://127.0.0.1:4200',
        bearerToken: 'secret',
        headers: {},
      }],
      { OPENCODE_CONFIG_CONTENT: '{not-json' },
    )).toThrow(/OPENCODE_CONFIG_CONTENT is not valid JSON/)
  })
})
