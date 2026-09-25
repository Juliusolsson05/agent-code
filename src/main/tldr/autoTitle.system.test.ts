import { afterEach, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { BuiltInMcpHttpHost } from '@mcp/runtime/BuiltInMcpHttpHost.js'

vi.mock('@main/performance/PerformanceService.js', () => ({ performanceService: { record: vi.fn() } }))

const hosts: BuiltInMcpHttpHost[] = []
const clients: Client[] = []
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()))
  await Promise.all(hosts.splice(0).map(host => host.stop()))
})

it('gives title_set only to the bearer-owning enabled agent and revokes it with the process', async () => {
  const writes: Array<{ sessionId: string; title: string }> = []
  const host = new BuiltInMcpHttpHost()
  hosts.push(host)
  host.setDependencies({ setOwnAutoTitle: async (sessionId, title, authorized) => {
    if (!authorized()) throw new Error('Auto Title session is no longer active.')
    writes.push({ sessionId, title })
    return title
  } })
  await host.start()
  const config = host.registerSession({ sessionId: 'agent-one', cwd: '/repo', providerKind: 'codex', domains: ['auto_title'] })[0]!
  const client = new Client({ name: 'title-client', version: '1' })
  clients.push(client)
  await client.connect(new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: { headers: { Authorization: `Bearer ${config.bearerToken}` } },
  }))
  expect((await client.listTools()).tools.find(tool => tool.name === 'title_set')?.inputSchema.properties)
    .toEqual({ title: expect.any(Object) })
  expect((await client.callTool({ name: 'title_set', arguments: { title: '  Repair queue  ', sessionId: 'victim' } })).isError).toBeFalsy()
  expect(writes).toEqual([{ sessionId: 'agent-one', title: 'Repair queue' }])
  host.revokeSession('agent-one')
  await expect(client.callTool({ name: 'title_set', arguments: { title: 'Stale' } })).rejects.toThrow()
  expect(writes).toHaveLength(1)
})
