import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createBuiltInMcpServer } from '@mcp/runtime/createBuiltInMcpServer.js'
import { BuiltInMcpHttpHost } from '@mcp/runtime/BuiltInMcpHttpHost.js'
import type { BuiltInMcpDomain } from '@mcp/shared/types.js'
import { GOAL_INSTRUCTIONS, TLDR_INSTRUCTIONS } from '@shared/types/tldr.js'
import { TldrStore } from './TldrStore.js'

vi.mock('@main/performance/PerformanceService.js', () => ({ performanceService: { record: vi.fn() } }))

const directories: string[] = []
const clients: Array<{ close(): Promise<void> }> = []
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()))
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
async function setup(domains: BuiltInMcpDomain[] = ['tldr']) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-code-tldr-'))
  directories.push(directory)
  const file = join(directory, 'tldr.json')
  const store = new TldrStore(file)
  let active = true
  const server = createBuiltInMcpServer({ sessionId: 'routing-1', tldrIdentity: 'agent-1', cwd: '/project', domains }, {
    tldrStore: store, isTldrWriteAuthorized: () => active,
  })
  const client = new Client({ name: 'tldr-test', version: '1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  clients.push(client, server)
  return { client, store, file, revoke: () => { active = false } }
}

describe('TLDR MCP and durable summaries', () => {
  it('uses real HTTP bearer scopes for two agents and rejects the old token after replacement', async () => {
    const { store, file } = await setup()
    const host = new BuiltInMcpHttpHost()
    let entered!: () => void
    let continueWrite!: () => void
    const pendingEntered = new Promise<void>(resolve => { entered = resolve })
    const pendingWrite = new Promise<void>(resolve => { continueWrite = resolve })
    // Hold one real HTTP request between initial token authorization and its
    // durable write. Rejecting only NEW requests after revocation would pass
    // a simple 401 test while letting this old process overwrite its successor.
    host.setDependencies({ tldrStore: { update: async (...args: Parameters<TldrStore['update']>) => {
      if (args[1] === 'Delayed old report.') { entered(); await pendingWrite }
      return store.update(...args)
    } } })
    await host.start()
    const connect = async (sessionId: string, tldrIdentity: string) => {
      const [config] = host.registerSession({ sessionId, tldrIdentity, cwd: '/project', providerKind: 'codex', domains: ['tldr'] })
      const client = new Client({ name: 'http-tldr-test', version: '1' })
      await client.connect(new StreamableHTTPClientTransport(new URL(config!.url), {
        requestInit: { headers: { Authorization: `Bearer ${config!.bearerToken}` } },
      }))
      clients.push(client)
      return client
    }
    try {
      const first = await connect('process-a', 'logical-a')
      const second = await connect('process-b', 'logical-b')
      await first.callTool({ name: 'tldr_update', arguments: { text: 'A needs your decision.', identity: 'logical-b' } })
      await second.callTool({ name: 'tldr_update', arguments: { text: 'B is testing.' } })
      const staleResult = first.callTool({ name: 'tldr_update', arguments: { text: 'Delayed old report.' } })
      await pendingEntered
      host.revokeSession('process-a')
      const replacement = await connect('process-a-new', 'logical-a')
      await replacement.callTool({ name: 'tldr_update', arguments: { text: 'A is complete.' } })
      continueWrite()
      expect((await staleResult).isError).toBe(true)
      await expect(first.callTool({ name: 'tldr_update', arguments: { text: 'Stale old process.' } })).rejects.toThrow()
      const restored = await new TldrStore(file).read(['logical-a', 'logical-b', 'process-a-new'])
      expect(restored['logical-a']).toMatchObject({ text: 'A is complete.', revision: 2 })
      expect(restored['logical-b']).toMatchObject({ text: 'B is testing.', revision: 1 })
      expect(restored['process-a-new']).toBeUndefined()
    } finally {
      continueWrite()
      await host.stop()
    }
  })

  it('advertises no reporting tool or instructions when disabled', async () => {
    const { client, store } = await setup([])
    await expect(client.callTool({ name: 'tldr_update', arguments: { text: 'Must not be saved.' } })).rejects.toMatchObject({ code: -32601 })
    expect(client.getInstructions()).toBeUndefined()
    expect(await store.read(['agent-1'])).toEqual({})
  })

  it('replaces only the authenticated agent entry and restores it after restart', async () => {
    const { client, store, file } = await setup()
    const tools = (await client.listTools()).tools
    expect(tools.map(tool => tool.name)).toEqual(['tldr_update'])
    expect(tools[0]!.inputSchema.properties).not.toHaveProperty('sessionId')
    const changed = vi.fn()
    store.on('changed', changed)
    await client.callTool({ name: 'tldr_update', arguments: { text: 'Tests pass. Reviewing the PR.', sessionId: 'victim' } })
    const result = await client.callTool({ name: 'tldr_update', arguments: { text: '  PR #123 is merged.\nWork is complete. ' } })
    expect(result.isError).not.toBe(true)
    const snapshot = await new TldrStore(file).read(['agent-1', 'victim'])
    expect(Object.keys(snapshot)).toEqual(['agent-1'])
    expect(snapshot['agent-1']).toMatchObject({ text: 'PR #123 is merged. Work is complete.', revision: 2 })
    expect(changed).toHaveBeenCalledTimes(2)
    expect(JSON.parse(await readFile(file, 'utf8')).records).toEqual(snapshot)
  })

  it('rejects empty/oversized reports and revoked callers without changing the last summary', async () => {
    const { client, store, revoke } = await setup()
    await client.callTool({ name: 'tldr_update', arguments: { text: 'Waiting for your API decision.' } })
    for (const text of ['   ', 'x'.repeat(401), 'unsafe\u0000text']) {
      expect((await client.callTool({ name: 'tldr_update', arguments: { text } })).isError).toBe(true)
    }
    revoke()
    expect((await client.callTool({ name: 'tldr_update', arguments: { text: 'A stale caller overwrites the result.' } })).isError).toBe(true)
    expect((await store.read(['agent-1']))['agent-1']?.revision).toBe(1)
  })

  it('rechecks authorization after staging the write', async () => {
    const { store } = await setup()
    let checks = 0
    await expect(store.update('agent-1', 'Must never be published.', () => ++checks === 1)).rejects.toThrow('no longer active')
    expect(await store.read(['agent-1'])).toEqual({})
  })

  it('treats object-property names as ordinary opaque identities after prior writes', async () => {
    const { store, file } = await setup()
    await store.update('agent-1', 'First agent.', () => true)
    await store.update('constructor', 'Second agent.', () => true)
    expect((await new TldrStore(file).read(['constructor'])).constructor).toMatchObject({ text: 'Second agent.', revision: 1 })
  })

  it('preserves malformed storage instead of resetting it on the next update', async () => {
    const { file } = await setup()
    await writeFile(file, '{broken')
    await expect(new TldrStore(file).update('agent-1', 'Done.', () => true)).rejects.toThrow()
    expect(await readFile(file, 'utf8')).toBe('{broken')
  })
})

describe('Goal MCP', () => {
  async function goalSetup(domains: BuiltInMcpDomain[]) {
    const directory = await mkdtemp(join(tmpdir(), 'agent-code-goal-'))
    directories.push(directory)
    const tldr = new TldrStore(join(directory, 'tldr.json'))
    const goal = new TldrStore(join(directory, 'goal.json'), undefined, { historyDirectoryName: 'goal-history', label: 'Goal' })
    let active = true
    const server = createBuiltInMcpServer({ sessionId: 'routing-1', tldrIdentity: 'agent-1', cwd: '/project', domains }, {
      tldrStore: tldr, goalStore: goal, isTldrWriteAuthorized: () => active,
    })
    const client = new Client({ name: 'goal-test', version: '1' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    clients.push(client, server)
    return { client, tldr, goal, directory, revoke: () => { active = false } }
  }

  it('writes only the authenticated agent’s goal, kept apart from its TLDR and TLDR history', async () => {
    const { client, tldr, goal, directory } = await goalSetup(['tldr', 'goal'])
    const tools = (await client.listTools()).tools
    expect(tools.map(tool => tool.name).sort()).toEqual(['goal_set', 'tldr_update'])
    expect(tools.find(tool => tool.name === 'goal_set')!.inputSchema.properties).toEqual({ text: expect.any(Object) })
    await client.callTool({ name: 'goal_set', arguments: { text: 'Make reloads lossless.', identity: 'victim' } })
    await client.callTool({ name: 'tldr_update', arguments: { text: 'Reading the reload path.' } })

    expect(await goal.read(['agent-1', 'victim'])).toEqual({ 'agent-1': expect.objectContaining({ text: 'Make reloads lossless.', revision: 1 }) })
    expect(await tldr.read(['agent-1'])).toEqual({ 'agent-1': expect.objectContaining({ text: 'Reading the reload path.', revision: 1 }) })
    expect((await goal.history('agent-1')).map(entry => entry.text)).toEqual(['Make reloads lossless.'])
    expect((await tldr.history('agent-1')).map(entry => entry.text)).toEqual(['Reading the reload path.'])
    expect((await readdir(directory)).sort()).toEqual(['goal-history', 'goal.json', 'tldr-history', 'tldr.json'])
  })

  it('names Goal in the errors an agent reads and refuses a revoked caller', async () => {
    const { client, goal, revoke } = await goalSetup(['goal'])
    const empty = await client.callTool({ name: 'goal_set', arguments: { text: '   ' } })
    expect(empty.isError).toBe(true)
    expect(JSON.stringify(empty.content)).toContain('Goal must contain')
    await client.callTool({ name: 'goal_set', arguments: { text: 'Ship Goal.' } })
    revoke()
    const stale = await client.callTool({ name: 'goal_set', arguments: { text: 'A stale goal.' } })
    expect(stale.isError).toBe(true)
    expect(JSON.stringify(stale.content)).toContain('This Goal session is no longer active.')
    expect((await goal.read(['agent-1']))['agent-1']).toMatchObject({ text: 'Ship Goal.', revision: 1 })
  })

  it('offers and teaches only the capabilities the scope carries', async () => {
    const goalOnly = await goalSetup(['goal'])
    expect((await goalOnly.client.listTools()).tools.map(tool => tool.name)).toEqual(['goal_set'])
    expect(goalOnly.client.getInstructions()).toContain(GOAL_INSTRUCTIONS)
    expect(goalOnly.client.getInstructions()).not.toContain(TLDR_INSTRUCTIONS)

    const tldrOnly = await goalSetup(['tldr'])
    expect((await tldrOnly.client.listTools()).tools.map(tool => tool.name)).toEqual(['tldr_update'])
    // With another tool registered the SDK answers an unknown tool with an
    // error result rather than a protocol rejection; either way nothing saves.
    expect((await tldrOnly.client.callTool({ name: 'goal_set', arguments: { text: 'Must not be saved.' } })).isError).toBe(true)
    expect(tldrOnly.client.getInstructions()).not.toContain(GOAL_INSTRUCTIONS)
    expect(await tldrOnly.goal.read(['agent-1'])).toEqual({})
  })
})
