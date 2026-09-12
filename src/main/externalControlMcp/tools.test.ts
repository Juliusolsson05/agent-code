import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineCapability, type ControlOperatorPort, type ControlRequest } from '@control-sdk'
import { createOperatorMcpServer, registerOperatorControlTools } from './tools'

// One fixture catalog covers the schema shapes the real catalog uses: a
// recursive JSON value, nested strict objects with nullable/enum members, a
// main-executed operation whose routing only carries requestKey, and an
// application-only capability that must never become a tool. None of these
// stand in for a real feature; they exercise the projection contract.
const windowOwner = { kind: 'window' as const, windowId: 'window-two', generation: 'current' }
const echo = defineCapability({ id: 'probe.echo', title: 'Echo payload', execution: 'window', effect: 'read',
  description: 'Return the exact supplied payload; see probe.grid for layout shapes.',
  input: z.object({ payload: z.json().describe('JSON value to round-trip without modification.') }).strict(),
  output: z.object({ payload: z.json() }), handler: input => input })
const grid = defineCapability({ id: 'probe.grid', title: 'Configure probe grid', execution: 'window', effect: 'mutation',
  description: 'Set rows for the probe grid.',
  input: z.object({
    scope: z.enum(['project', 'global']).describe('Which projects the rows cover.'),
    rows: z.array(z.object({ length: z.number().int().min(1).max(4), sourceRow: z.number().int().min(0).nullable().describe('Existing row to retain, or null.') }).strict()).min(1).max(3).optional(),
  }).strict(),
  output: z.object({ applied: z.literal(true) }), handler: () => ({ applied: true as const }) })
const observe = defineCapability({ id: 'app.observe', title: 'Observe all windows', execution: 'main', effect: 'read',
  description: 'Read every window.', input: z.object({}).strict(), output: z.object({ windows: z.number() }), handler: () => ({ windows: 1 }) })
const privateCapability = defineCapability({ id: 'probe.private', title: 'Private', description: 'Application-only test capability.',
  visibility: 'application', execution: 'main', effect: 'read', input: z.object({}), output: z.object({}), handler: () => ({}) })

function port(requests: ControlRequest[]): ControlOperatorPort {
  const rows = [
    { descriptor: echo.descriptor, owner: windowOwner },
    { descriptor: grid.descriptor, owner: windowOwner },
    { descriptor: observe.descriptor, owner: { kind: 'main' as const, generation: 'main' } },
    { descriptor: privateCapability.descriptor, owner: { kind: 'main' as const, generation: 'main' } },
  ]
  return {
    catalog: () => rows,
    invoke: async request => {
      requests.push(request)
      const context = { owner: request.owner ?? windowOwner, caller: { kind: 'agent' as const, id: 'session-1' }, requestId: 'one' }
      const capability = [echo, grid, observe].find(item => item.descriptor.id === request.capabilityId)!
      return capability.execute(request.input, context)
    },
    recordTransport: async () => {},
  }
}

async function withClient<T>(connect: (transport: ReturnType<typeof InMemoryTransport.createLinkedPair>[1]) => Promise<void>, run: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: 'projection-trial', version: '1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await connect(serverTransport)
  await client.connect(clientTransport)
  try { return await run(client) } finally { await client.close() }
}

type Listed = Awaited<ReturnType<Client['listTools']>>['tools']

function summarize(tools: Listed) {
  return tools.map(tool => ({
    name: tool.name, title: tool.title, description: tool.description, annotations: tool.annotations,
    required: [...((tool.inputSchema.required as string[] | undefined) ?? [])].sort(),
    properties: Object.fromEntries(Object.entries((tool.inputSchema.properties ?? {}) as Record<string, { description?: string }>)
      .map(([key, value]) => [key, value.description ?? null])),
    control: Object.keys(((tool.inputSchema.properties as Record<string, { properties?: Record<string, unknown> }> | undefined)?._control?.properties) ?? {}).sort(),
    additionalProperties: tool.inputSchema.additionalProperties,
  }))
}

describe('operator catalog projections', () => {
  it('publishes the same tools, argument documentation and routing through the external Server and the built-in McpServer', async () => {
    const external = await withClient(transport => createOperatorMcpServer(port([])).connect(transport), client => client.listTools())
    const builtIn = await withClient(async transport => {
      const server = new McpServer({ name: 'built-in-trial', version: '0' })
      expect(registerOperatorControlTools(server, port([]))).toBe(3)
      await server.connect(transport)
    }, client => client.listTools())

    // The failure scenario: a change to one projection (a renamed tool, a lost
    // description, a missing _control field, a hidden capability leaking) that
    // the other projection does not make, so the operator guide stops
    // describing what a root-managed agent actually sees.
    expect(summarize(builtIn.tools)).toEqual(summarize(external.tools))
    expect(external.tools.map(tool => tool.name)).toEqual(['ac_app_observe', 'ac_probe_echo', 'ac_probe_grid'])
    const gridTool = summarize(builtIn.tools).find(tool => tool.name === 'ac_probe_grid')!
    expect(gridTool.properties).toEqual({ scope: 'Which projects the rows cover.', rows: null, _control: null })
    expect(gridTool.required).toEqual(['scope'])
    expect(gridTool.additionalProperties).toBe(false)
    expect(gridTool.control).toEqual(['generation', 'requestKey', 'windowId'])
    expect(summarize(builtIn.tools).find(tool => tool.name === 'ac_app_observe')!.control).toEqual(['requestKey'])
    // Cross-references inside descriptions are rewritten to tool names on
    // both sides, which is what makes the shared operator guide readable.
    expect(gridTool.description).toContain('Set rows for the probe grid.')
    expect(summarize(builtIn.tools).find(tool => tool.name === 'ac_probe_echo')!.description).toContain('see ac_probe_grid for layout shapes')
  })

  it('routes built-in calls through the same request shape as external calls, and keeps application-only capabilities uncallable', async () => {
    const externalRequests: ControlRequest[] = []
    const builtInRequests: ControlRequest[] = []
    const payload = { nested: { values: ['hello', 3, null, true] } }
    const arguments_ = { payload, _control: { windowId: 'window-two', requestKey: 'echo-intention' } }

    const externalResult = await withClient(transport => createOperatorMcpServer(port(externalRequests)).connect(transport),
      client => client.callTool({ name: 'ac_probe_echo', arguments: arguments_ }))
    const builtInResult = await withClient(async transport => {
      const server = new McpServer({ name: 'built-in-trial', version: '0' })
      registerOperatorControlTools(server, port(builtInRequests))
      await server.connect(transport)
    }, async client => {
      const result = await client.callTool({ name: 'ac_probe_echo', arguments: arguments_ })
      const rejected = await client.callTool({ name: 'ac_probe_grid', arguments: { scope: 'everywhere' } })
      expect(rejected.isError).toBe(true)
      // The high-level SDK reports an unknown tool as an isError result rather
      // than a protocol error; either way the private capability is unreachable.
      const hidden = await client.callTool({ name: 'ac_probe_private', arguments: {} })
      expect(hidden.isError).toBe(true)
      expect(JSON.stringify(hidden.content)).toContain('ac_probe_private')
      const mainRouted = await client.callTool({ name: 'ac_app_observe', arguments: { _control: { requestKey: 'observe-once' } } })
      expect(mainRouted.structuredContent).toEqual({ ok: true, value: { windows: 1 } })
      return result
    })

    expect(builtInResult.structuredContent).toEqual({ ok: true, value: { payload } })
    expect(builtInResult.structuredContent).toEqual(externalResult.structuredContent)
    expect(builtInRequests[0]).toEqual(externalRequests[0])
    expect(builtInRequests[0]).toEqual({ capabilityId: 'probe.echo', input: { payload }, owner: windowOwner, requestKey: 'echo-intention' })
    // The invalid enum never reached the port: schema validation happened in
    // the projection, exactly as the external server would have refused it.
    expect(builtInRequests.map(request => request.capabilityId)).toEqual(['probe.echo', 'app.observe'])
    expect(builtInRequests[1]).toEqual({ capabilityId: 'app.observe', input: {}, requestKey: 'observe-once' })
  })
})
