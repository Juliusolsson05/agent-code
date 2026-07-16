import { describe, expect, it, vi } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

vi.mock('@main/performance/PerformanceService.js', () => ({
  performanceService: {
    record: vi.fn(),
  },
}))

const { BuiltInMcpHttpHost } = await import('@mcp/runtime/BuiltInMcpHttpHost.js')

function requestHeaders(config: { bearerToken?: string; headers: Record<string, string> }) {
  return {
    ...config.headers,
    ...(config.bearerToken === undefined
      ? {}
      : { Authorization: `Bearer ${config.bearerToken}` }),
  }
}

describe('BuiltInMcpHttpHost', () => {
  it('rejects browser origins outside the exact loopback endpoint', async () => {
    const host = new BuiltInMcpHttpHost(() => new McpServer(
      { name: 'origin-test', version: '0.0.0' },
      { capabilities: { tools: {} } },
    ))

    await host.start()
    const [config] = host.registerSession({
      sessionId: 'session-origin',
      cwd: '/tmp/project',
      domains: ['orchestration'],
    })
    expect(config).toBeDefined()

    try {
      const hostile = await fetch(config!.url, {
        headers: {
          Origin: 'https://attacker.example',
          ...requestHeaders(config!),
        },
      })
      expect(hostile.status).toBe(403)
      await expect(hostile.json()).resolves.toEqual({ error: 'forbidden_origin' })

      // A same-endpoint Origin must get past the DNS-rebinding guard. Omitting
      // credentials makes the following 401 deterministic without opening the
      // intentionally long-lived GET event stream.
      const endpoint = new URL(config!.url)
      endpoint.search = ''
      const local = await fetch(endpoint, {
        headers: { Origin: endpoint.origin },
      })
      expect(local.status).toBe(401)
      await expect(local.json()).resolves.toEqual({ error: 'unauthorized' })
    } finally {
      await host.stop()
    }
  })

  it('rejects lookalike loopback origins with a different port', async () => {
    const host = new BuiltInMcpHttpHost(() => new McpServer(
      { name: 'port-test', version: '0.0.0' },
      { capabilities: { tools: {} } },
    ))

    await host.start()
    const [config] = host.registerSession({
      sessionId: 'session-port',
      cwd: '/tmp/project',
      domains: ['orchestration'],
    })
    try {
      const response = await fetch(config!.url, {
        headers: {
          Origin: 'http://127.0.0.1:1',
          ...requestHeaders(config!),
        },
      })
      expect(response.status).toBe(403)
    } finally {
      await host.stop()
    }
  })

  it('serves standalone GET streams without constructing the scoped tool server', async () => {
    let factoryCalls = 0
    const host = new BuiltInMcpHttpHost((scope, dependencies) => {
      factoryCalls += 1
      return new McpServer(
        {
          name: `test-${scope.sessionId}-${dependencies ? 'deps' : 'none'}`,
          version: '0.0.0',
        },
        { capabilities: { tools: {} } },
      )
    })

    await host.start()
    const [config] = host.registerSession({
      sessionId: 'session-1',
      cwd: '/tmp/project',
      domains: ['orchestration'],
    })
    expect(config).toBeDefined()

    const abort = new AbortController()
    try {
      const response = await fetch(config!.url, {
        headers: {
          Accept: 'text/event-stream',
          ...requestHeaders(config!),
        },
        signal: abort.signal,
      })
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('text/event-stream')
      expect(factoryCalls).toBe(0)

      const reader = response.body?.getReader()
      expect(reader).toBeDefined()
      const readOutcome = reader!.read().then(
        result => ({ state: 'settled' as const, result }),
        err => ({ state: 'rejected' as const, err }),
      )
      await expect(Promise.race([
        readOutcome,
        new Promise(resolve => setTimeout(() => resolve({ state: 'pending' }), 50)),
      ])).resolves.toEqual({ state: 'pending' })
    } finally {
      abort.abort()
      await host.stop()
    }
  })
})
