import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it } from 'vitest'

import { createBuiltInMcpServer } from '@mcp/runtime/createBuiltInMcpServer.js'
import type { BuiltInMcpDependencies } from '@mcp/runtime/BuiltInMcpHttpHost.js'
import {
  BUILT_IN_MCP_DOMAINS,
  CONFIGURABLE_BUILT_IN_MCP_DOMAINS,
  CONFIRMATION_GATED_BUILT_IN_MCP_DOMAINS,
  PARENT_HELD_ONLY_BUILT_IN_MCP_DOMAINS,
  filterBuiltInMcpDomainsForProvider,
  type BuiltInMcpDomain,
} from '@mcp/shared/types.js'
import { readFileSync } from 'node:fs'

import { bridgeOn } from '@main/hermes/testing/hermesReplay.js'

// #1512: the `hermes` domain at the tool boundary, through a real MCP client,
// a real HermesAgentBridge, and a RECORDED Hermes turn (S4, v0.22.0) played
// by the replay server (src/main/hermes/testing/hermesReplay.ts).

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function connect(domains: BuiltInMcpDomain[], dependencies: BuiltInMcpDependencies) {
  const server = createBuiltInMcpServer({ sessionId: 'agent-1', tldrIdentity: 'identity-1', cwd: '/tmp/project', domains }, dependencies)
  const client = new Client({ name: 'hermes-domain-test', version: '0.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return client
}

const parse = (result: Awaited<ReturnType<Client['callTool']>>) => JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as Record<string, unknown>

describe('hermes MCP domain (#1512)', () => {
  it('a recorded Hermes turn reaches the agent as its reply text, in a conversation named after the agent\'s Goal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hermes-tools-'))
    dirs.push(dir)
    const { bridge, dials } = bridgeOn('S4', dir)
    const client = await connect(['hermes'], {
      hermesAgentBridge: bridge,
      sessionTitle: async (scope) => (scope.tldrIdentity === 'identity-1' ? 'Fix the flaky test' : null),
    })
    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual(['hermes_conversations', 'hermes_read', 'hermes_send'])
    expect(client.getInstructions() ?? '').toContain('hermes_send')

    const result = await client.callTool({ name: 'hermes_send', arguments: { text: '[[hh:tools]] Run the tools.', timeoutSeconds: 20 } })
    expect(result.isError).not.toBe(true)
    const value = parse(result)
    expect(value).toMatchObject({ ok: true, status: 'replied', reply: 'All three tools ran.', conversationId: '20261014_092150_c02da4' })
    expect(dials[0]!.sent.find((frame) => frame.method === 'session.create')!.params).toMatchObject({ title: 'Agent Code · Fix the flaky test' })
    // Nothing credential-shaped ever reaches the model.
    expect(JSON.stringify(value)).not.toMatch(/token|ticket|authorization|bearer/i)
    await client.close()
  }, 30_000)

  it('registers nothing while the domain is off', async () => {
    const client = await connect(['usage'], { readUsageSnapshot: async () => ({}) })
    expect((await client.listTools()).tools.some((tool) => tool.name.startsWith('hermes_'))).toBe(false)
    expect(client.getInstructions() ?? '').not.toContain('hermes_')
    await client.close()
  })

  it('without a wired bridge: a curated error, and no instructions teaching tools that can only fail', async () => {
    const client = await connect(['hermes'], {})
    expect(client.getInstructions() ?? '').not.toContain('hermes_send')
    const result = await client.callTool({ name: 'hermes_read', arguments: {} })
    expect(result.isError).toBe(true)
    expect(parse(result)).toEqual({ ok: false, message: 'Hermes is unavailable in this build.' })
    await client.close()
  })

  it('passes the bridge\'s own words through, and hides anything else behind one sentence', async () => {
    const bridgeError = Object.assign(new Error('No signed-in Hermes connection. Sign in under Settings → Providers → Hermes.'), { name: 'HermesBridgeError', code: 'not-signed-in' })
    const raw = new Error('connect ECONNREFUSED 100.64.0.3:9119 Authorization: Bearer abc')
    const client = await connect(['hermes'], {
      hermesAgentBridge: {
        conversations: async () => { throw bridgeError },
        read: async () => { throw raw },
        send: async () => { throw raw },
      },
    })
    expect(parse(await client.callTool({ name: 'hermes_conversations', arguments: {} }))).toEqual({ ok: false, code: 'not-signed-in', message: bridgeError.message })
    const hidden = parse(await client.callTool({ name: 'hermes_read', arguments: {} }))
    expect(hidden).toEqual({ ok: false, message: 'The Hermes request failed.' })
    await client.close()
  })

  it('is optional, off by default, parent-held-only, never confirmation-gated, and not offered to Hermes itself', () => {
    expect(BUILT_IN_MCP_DOMAINS).toContain('hermes')
    expect(CONFIGURABLE_BUILT_IN_MCP_DOMAINS).toContain('hermes')
    // Off until the owner switches it on: a send makes their Hermes act.
    // (Read as text: the shipped list is renderer code, outside this project.)
    const settingsTypes = readFileSync(join(import.meta.dirname, '../../renderer/src/app-state/settings/types.ts'), 'utf8')
    const shipped = /SHIPPED_BUILT_IN_MCP_DOMAINS[^=]*=\s*\[([^\]]*)\]/.exec(settingsTypes)?.[1] ?? ''
    expect(shipped).not.toBe('')
    expect(shipped).not.toContain("'hermes'")
    expect(PARENT_HELD_ONLY_BUILT_IN_MCP_DOMAINS.has('hermes')).toBe(true)
    expect(CONFIRMATION_GATED_BUILT_IN_MCP_DOMAINS as readonly string[]).not.toContain('hermes')
    for (const provider of ['claude', 'codex', 'opencode', 'grok', 'pi'] as const) {
      expect(filterBuiltInMcpDomainsForProvider(provider, ['hermes'])).toEqual(['hermes'])
    }
    // A Hermes agent runs on the VPS and cannot reach this Mac's loopback.
    expect(filterBuiltInMcpDomainsForProvider('hermes', ['hermes'])).toEqual([])
  })
})
