import { afterEach, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { z } from 'zod'
import { defineCapability, type ControlOperatorPort } from '@control-sdk'
import { ExternalControlMcpHost } from './host'

const hosts: ExternalControlMcpHost[] = []
afterEach(async () => { await Promise.all(hosts.splice(0).map(host => host.stop())) })

it('publishes typed descriptions and the actual result envelope, rejects browser/unauthenticated requests, and records full protocol results', async () => {
  const owner = { kind: 'window' as const, windowId: 'window-two', generation: 'current' }
  const context = { owner, caller: { kind: 'external' as const, id: 'trial' }, requestId: 'one' }
  // This is a transport codec probe. Its capability deliberately returns a
  // recursive JSON value to exercise embedded output-schema references; it
  // does not pretend to model any provider or application's domain behavior.
  const capability = defineCapability({ id: 'probe.echo', title: 'Echo payload', execution: 'window', effect: 'read',
    description: 'Return the exact supplied payload; use to verify JSON transport.',
    input: z.object({ payload: z.json().describe('JSON value to round-trip without modification.') }).strict(),
    output: z.object({ payload: z.json() }), handler: input => input })
  const privateCapability = defineCapability({ id: 'probe.private', title: 'Private', description: 'Application-only test capability.', visibility: 'application', execution: 'main', effect: 'read', input: z.object({}), output: z.object({}), handler: () => ({}) })
  const events: Parameters<ControlOperatorPort['recordTransport']>[0][] = []
  const requests: unknown[] = []
  const host = new ExternalControlMcpHost({ catalog: () => [{ descriptor: capability.descriptor, owner }, { descriptor: privateCapability.descriptor, owner: { kind: 'main', generation: 'main' } }],
    invoke: async request => { requests.push(request); return capability.execute(request.input, context) },
    recordTransport: async event => { events.push(event) },
  }); hosts.push(host)
  const port = await host.start(0, 'fixture-private-token')
  const url = `http://127.0.0.1:${port}/mcp`
  expect((await fetch(url, { method: 'POST', body: '{}' })).status).toBe(401)
  expect((await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer fixture-private-token', Origin: 'https://example.invalid' }, body: '{}' })).status).toBe(403)
  expect(events).toEqual([])
  const client = new Client({ name: 'codec-trial', version: '1' })
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: 'Bearer fixture-private-token' } } }))
    const list = await client.listTools()
    expect(list.tools.map(tool => tool.name)).toEqual(['ac_probe_echo'])
    const tool = list.tools[0]
    expect(tool.inputSchema.properties?.payload).toHaveProperty('description')
    expect(tool.inputSchema.properties?._control).toBeDefined()
    expect(tool.outputSchema?.properties).toHaveProperty('operation')
    const payload = { nested: { values: ['hello', 3, null, true] }, text: '😀'.repeat(40_000) }
    const result = await client.callTool({ name: 'ac_probe_echo', arguments: { payload, _control: { windowId: 'window-two', requestKey: 'echo-intention' } } })
    expect(result.structuredContent).toEqual({ ok: true, value: { payload } })
    expect(requests).toEqual([{ capabilityId: 'probe.echo', input: { payload }, owner, requestKey: 'echo-intention' }])
    const callEvents = events.filter(event => event.method === 'tools/call')
    expect(callEvents.map(event => event.direction)).toEqual(['request', 'response'])
    expect(JSON.stringify(callEvents)).toContain(payload.text)
    expect(JSON.stringify(events)).not.toContain('fixture-private-token')
    await expect(client.callTool({ name: 'ac_probe_private', arguments: {} })).rejects.toThrow('Unknown control tool')
  } finally { await client.close() }
  await host.stop()
  await expect(fetch(url)).rejects.toThrow()
})
