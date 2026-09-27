import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, vi } from 'vitest'

import { createBuiltInMcpServer } from '@mcp/runtime/createBuiltInMcpServer.js'
import { filterBuiltInMcpDomainsForProvider, CONFIGURABLE_BUILT_IN_MCP_DOMAINS, CONFIRMATION_GATED_BUILT_IN_MCP_DOMAINS, PARENT_HELD_ONLY_BUILT_IN_MCP_DOMAINS, type BuiltInMcpDomain } from '@mcp/shared/types.js'
import { AGENT_PROVIDER_KINDS } from '@shared/types/providerKind.js'

// #1339: the `usage` domain at the tool boundary, through a real MCP client.
// The snapshot is a real `ac_usage_read` answer from the owner's machine
// (testing/fixtures/usage), so the property under test is that an agent
// WITHOUT root management gets that exact snapshot, all four sources, errors
// kept as errors.
const recorded = JSON.parse(readFileSync(join(import.meta.dirname,
  '../../../testing/fixtures/usage/snapshot-2026-09-27.json'), 'utf8')) as {
  snapshot: { providers: Array<{ id?: string; source?: string; error?: unknown }> }
}

async function connect(domains: BuiltInMcpDomain[], readUsageSnapshot?: () => Promise<unknown>) {
  const server = createBuiltInMcpServer({ sessionId: 'agent-1', cwd: '/tmp/project', domains }, { readUsageSnapshot })
  const client = new Client({ name: 'usage-domain-test', version: '0.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return client
}

describe('usage MCP domain (#1339)', () => {
  it('gives an agent without root management the recorded snapshot, unchanged', async () => {
    const read = vi.fn(async () => recorded.snapshot)
    const client = await connect(['usage'], read)
    const tools = (await client.listTools()).tools.map(tool => tool.name)
    expect(tools).toEqual(['usage_read'])
    expect(tools.some(name => name.startsWith('ac_'))).toBe(false)
    const result = await client.callTool({ name: 'usage_read', arguments: {} })
    expect(result.isError).not.toBe(true)
    const value = JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as { ok: boolean; snapshot: typeof recorded.snapshot }
    expect(value).toEqual({ ok: true, snapshot: recorded.snapshot })
    // Every recorded source reaches the agent; a source that errored stays an
    // error (the snapshot's contract), never a zero.
    expect(value.snapshot.providers.length).toBe(recorded.snapshot.providers.length)
    expect(read).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledWith()
    await client.close()
  })

  it('takes no `force`, so agents cannot bypass the shared cache', async () => {
    const client = await connect(['usage'], async () => recorded.snapshot)
    const tool = (await client.listTools()).tools.find(candidate => candidate.name === 'usage_read')!
    expect(Object.keys((tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {})).toEqual([])
    await client.close()
  })

  it('offers no usage tool or instructions without the domain', async () => {
    const client = await connect(['tldr'], async () => recorded.snapshot)
    expect((await client.listTools()).tools.map(tool => tool.name)).not.toContain('usage_read')
    expect(client.getInstructions() ?? '').not.toContain('usage_read')
    await client.close()
  })

  it('answers a curated error when usage cannot be read', async () => {
    for (const read of [undefined, async () => { throw new Error('GET https://api.example/usage failed: token=abc') }]) {
      const client = await connect(['usage'], read)
      const result = await client.callTool({ name: 'usage_read', arguments: {} })
      expect(result.isError).toBe(true)
      const text = (result.content as Array<{ text: string }>)[0]!.text
      expect(text).not.toContain('token=')
      expect(text).not.toContain('https://')
      await client.close()
    }
  })

  // A user (or an orchestrating parent) can turn it on, on every provider,
  // without the root-management confirmation gate. "Off by default" is
  // pinned beside the shipped list in settings/persistence.test.ts: that list
  // is renderer state, and importing it here would pull renderer files into
  // the node program.
  it('is configurable on every provider and not gated', () => {
    expect(CONFIGURABLE_BUILT_IN_MCP_DOMAINS).toContain('usage')
    expect(CONFIRMATION_GATED_BUILT_IN_MCP_DOMAINS).not.toContain('usage')
    expect(PARENT_HELD_ONLY_BUILT_IN_MCP_DOMAINS.has('usage')).toBe(false)
    for (const provider of AGENT_PROVIDER_KINDS) expect(filterBuiltInMcpDomainsForProvider(provider, ['usage'])).toEqual(['usage'])
  })
})
