import { describe, expect, it } from 'vitest'

import { addOpencodeBuiltInMcpLaunchConfig, addPiBuiltInMcpLaunchConfig } from './builtInMcpLaunch.js'

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

describe('addPiBuiltInMcpLaunchConfig', () => {
  it('never lets a pane inherit another pane’s MCP servers and bearer, even when it has none of its own', () => {
    const inherited = {
      AGENT_CODE_PI_MCP_SERVERS: JSON.stringify([{ name: 'agent_code', url: 'http://127.0.0.1:1/outer', headerEnv: { Authorization: 'AGENT_CODE_MCP_0_0' } }]),
      AGENT_CODE_MCP_0_0: 'Bearer outer-pane',
      PATH: '/usr/bin',
    }
    const disabled: Record<string, string> = { ...inherited }
    addPiBuiltInMcpLaunchConfig([], disabled)
    expect(disabled).toEqual({ PATH: '/usr/bin' })

    const own: Record<string, string> = { ...inherited }
    addPiBuiltInMcpLaunchConfig([{ name: 'agent_code', url: 'http://127.0.0.1:2/mine', bearerToken: 'mine', headers: {} }], own)
    expect(JSON.parse(own.AGENT_CODE_PI_MCP_SERVERS!)).toEqual([{ name: 'agent_code', url: 'http://127.0.0.1:2/mine', headerEnv: { Authorization: 'AGENT_CODE_MCP_0_0' } }])
    expect(own.AGENT_CODE_MCP_0_0).toBe('Bearer mine')
  })
})
