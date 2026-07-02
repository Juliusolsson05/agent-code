import { describe, expect, it, vi } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

vi.mock('@main/performance/PerformanceService.js', () => ({
  performanceService: {
    record: vi.fn(),
  },
}))

const { BuiltInMcpHttpHost } = await import('@mcp/runtime/BuiltInMcpHttpHost.js')

describe('BuiltInMcpHttpHost', () => {
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
          ...config!.headers,
        },
        signal: abort.signal,
      })
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('text/event-stream')
      expect(factoryCalls).toBe(0)
    } finally {
      abort.abort()
      await host.stop()
    }
  })
})
