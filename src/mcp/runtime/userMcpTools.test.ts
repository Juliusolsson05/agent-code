import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { UserMcpService } from '@main/userMcp/service.js'
import { createBuiltInMcpServer } from '@mcp/runtime/createBuiltInMcpServer.js'
import type { BuiltInMcpDomain } from '@mcp/shared/types.js'

// The mcp_servers domain drives the REAL UserMcpService over a temp state
// dir: the property under test is that an agent changes exactly what Settings
// would, through the same validation, and can never read a secret back.

const TOKEN = 'bpr_live_9f3a1c7d'
const codec = {
  isEncryptionAvailable: () => true,
  encrypt: (plain: string) => Buffer.from(`enc:${plain}`),
  decrypt: (cipher: Buffer) => cipher.toString().slice(4),
}

let dir: string
let service: UserMcpService
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mcp-tools-'))
  service = new UserMcpService({
    stateDir: dir,
    codec,
    native: { list: async () => [], codexNames: async () => new Set(), claudeManagedPolicy: async () => false },
  })
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

async function connect(domains: BuiltInMcpDomain[], onUserMcpChangedByAgent = vi.fn()) {
  const server = createBuiltInMcpServer(
    { sessionId: 'agent-1', cwd: '/tmp/project', domains },
    { userMcpService: service, onUserMcpChangedByAgent },
  )
  const client = new Client({ name: 'mcp-servers-domain-test', version: '0.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args })
    const text = (result.content as { text: string }[])[0]!.text
    // Schema rejections (e.g. `enabled: true`, which the schema forbids) come
    // back as plain MCP error text, not our JSON envelope.
    let value: Record<string, unknown>
    try { value = JSON.parse(text) as Record<string, unknown> } catch { value = { message: text } }
    return { isError: result.isError === true, text, value }
  }
  return { client, call, close: async () => { await client.close(); await server.close() } }
}

describe('mcp_servers built-in domain', () => {
  it('is only exposed when the domain is granted', async () => {
    const without = await connect(['tldr'])
    expect((await without.client.listTools()).tools.map(tool => tool.name)).not.toContain('mcp_servers_add')
    await without.close()
    const withDomain = await connect(['mcp_servers'])
    expect((await withDomain.client.listTools()).tools.map(tool => tool.name).sort()).toEqual([
      'mcp_servers_add', 'mcp_servers_list', 'mcp_servers_remove', 'mcp_servers_set_secret', 'mcp_servers_update',
    ])
    expect(withDomain.client.getInstructions()).toContain('never add a server on your own initiative')
    await withDomain.close()
  })

  it('adds Beeper from its official snippet, keeps the token out of every reply and the document, and tells the user', async () => {
    const announce = vi.fn()
    const { call, close } = await connect(['mcp_servers'], announce)
    const added = await call('mcp_servers_add', {
      config: JSON.stringify({ mcpServers: { beeper: { url: 'http://localhost:23373/v0/mcp', headers: { Authorization: `Bearer ${TOKEN}` } } } }),
    })
    expect(added.isError).toBe(false)
    expect(added.text).not.toContain(TOKEN)
    expect(await readFile(join(dir, 'mcp-servers.json'), 'utf8')).not.toContain(TOKEN)
    const listed = await call('mcp_servers_list')
    expect(listed.text).not.toContain(TOKEN)
    // Not even the Settings last-4 hint. Asserted structurally: a substring
    // check for the hint would also match a random server UUID that happens
    // to contain those four hex characters.
    expect(listed.text).not.toContain('"hint"')
    expect((listed.value.servers as { secrets: Record<string, string> }[])[0]!.secrets).toEqual({ 'beeper-authorization': 'set' })
    expect(announce).toHaveBeenCalledWith({ sessionId: 'agent-1', message: 'An agent added MCP server beeper (off until you review it)' })
    // Review round 2: an agent proposes, the user approves. Nothing attaches
    // until the user turns it on; then the stored secret is there.
    const id = (await service.snapshot()).servers[0]!.id
    expect((await service.snapshot()).servers[0]!.enabled).toBe(false)
    expect((await service.resolveForLaunch({ provider: 'codex', overrides: {}, cwd: dir })).servers).toEqual([])
    await service.setEnabled(id, true)
    const launch = await service.resolveForLaunch({ provider: 'codex', overrides: {}, cwd: dir })
    expect(launch.servers[0]!.secrets).toEqual({ 'beeper-authorization': TOKEN })
    // And the agent was never shown the raw entry.
    expect(listed.text).not.toContain('"entry"')
    await close()
  })

  it('refuses what Settings would refuse, and changes nothing', async () => {
    const announce = vi.fn()
    const { call, close } = await connect(['mcp_servers'], announce)
    const result = await call('mcp_servers_add', { config: '{"url":"http://x/mcp"}', name: 'agent_code' })
    expect(result.isError).toBe(true)
    expect(result.value.message).toMatch(/reserved/)
    expect(announce).not.toHaveBeenCalled()
    expect((await service.snapshot()).servers).toEqual([])
    await close()
  })

  it('updates, sets a secret for, and removes a server by id', async () => {
    const { call, close } = await connect(['mcp_servers'])
    await call('mcp_servers_add', { config: '{"command":"npx","args":["-y","@beeper/mcp-remote"],"env":{"ACCESS_TOKEN":"YOUR_TOKEN_HERE"}}', name: 'beeper' })
    const id = (await service.snapshot()).servers[0]!.id
    expect((await service.snapshot()).servers[0]!.secrets['beeper-access_token']).toEqual({ set: false })

    const secret = await call('mcp_servers_set_secret', { id, inputId: 'beeper-access_token', value: TOKEN })
    expect(secret.text).not.toContain(TOKEN)
    expect((await service.snapshot()).servers[0]!.secrets['beeper-access_token']!.set).toBe(true)

    await call('mcp_servers_update', { id, codex: false })
    expect((await service.snapshot()).servers[0]!.providers).toEqual({ claude: true, codex: false })

    await call('mcp_servers_remove', { id })
    expect((await service.snapshot()).servers).toEqual([])
    await close()
  })

  // #1420 q127: the agent tool is the AGENT path, never the user path. A
  // value it sets turns the server off for review and withholds the sibling
  // secret; if the tool ever passed the user actor, the sibling would be
  // rebound and keep launching.
  it('set_secret from an agent turns a reviewed server off and withholds its other secret', async () => {
    const saved = await service.save({
      name: 'svc',
      enabled: true,
      providers: { claude: true, codex: true },
      entry: { command: 'node', args: ['client.js'], env: { API_BASE_URL: '${input:base}', API_KEY: '${input:key}' } },
      inputs: [{ id: 'base', description: 'base' }, { id: 'key', description: 'key' }],
      secrets: { base: 'https://trusted.example', key: TOKEN },
    })
    expect(saved.ok).toBe(true)
    const id = (await service.snapshot()).servers[0]!.id
    const { call, close } = await connect(['mcp_servers'])
    await call('mcp_servers_set_secret', { id, inputId: 'key', value: 'agent-chosen-value-9999' })
    const [server] = (await service.snapshot()).servers
    expect(server!.pendingReview).toBe(true)
    expect(server!.enabled).toBe(false)
    expect(server!.secrets.base).toMatchObject({ set: false, unconfirmed: 'inputs-changed' })
    await close()
  })

  // r3 round-2 reviews a+b: the remove tool is the AGENT path, so a server
  // holding a withheld secret cannot be removed through it.
  it('remove refuses a server whose secret is withheld for the user', async () => {
    await service.save({
      name: 'svc',
      enabled: true,
      providers: { claude: true, codex: true },
      entry: { command: 'node', args: ['client.js'], env: { API_BASE_URL: '${input:base}', API_KEY: '${input:key}' } },
      inputs: [{ id: 'base', description: 'base' }, { id: 'key', description: 'key' }],
      secrets: { base: 'https://trusted.example', key: TOKEN },
    })
    const id = (await service.snapshot()).servers[0]!.id
    await service.setSecret(id, 'base', 'https://evil.example', 'agent')
    const { call, close } = await connect(['mcp_servers'])
    const removed = await call('mcp_servers_remove', { id })
    expect(removed.isError).toBe(true)
    expect((await service.snapshot()).servers.map(server => server.id)).toEqual([id])
    await close()
  })

  // q131 through the exposed tools: mcp_servers_update drops every reference
  // (the server keeps no inputs), then mcp_servers_remove. The orphaned
  // secrets are the user's, so the removal is refused and the bytes stay.
  it('update dropping every reference, then remove, cannot delete the orphaned secrets', async () => {
    await service.save({
      name: 'svc',
      enabled: true,
      providers: { claude: true, codex: true },
      entry: { command: 'node', args: ['client.js'], env: { API_BASE_URL: '${input:base}', API_KEY: '${input:key}' } },
      inputs: [{ id: 'base', description: 'base' }, { id: 'key', description: 'key' }],
      secrets: { base: 'https://trusted.example', key: TOKEN },
    })
    const id = (await service.snapshot()).servers[0]!.id
    const keyFile = join(dir, 'mcp-secrets', id, 'key.bin')
    const keyBytes = await readFile(keyFile)
    const { call, close } = await connect(['mcp_servers'])
    const updated = await call('mcp_servers_update', { id, entry: { command: 'node', args: ['client.js'] } })
    expect(updated.isError).toBe(false)
    expect((await service.snapshot()).servers[0]!.inputs).toEqual([])
    const removed = await call('mcp_servers_remove', { id })
    expect(removed.isError).toBe(true)
    expect(await readFile(keyFile)).toEqual(keyBytes)
    await close()
  })

  it('cannot turn a server on (review round 2)', async () => {
    const { call, close } = await connect(['mcp_servers'])
    await call('mcp_servers_add', { config: '{"url":"https://x.dev/mcp"}', name: 'x' })
    const id = (await service.snapshot()).servers[0]!.id
    const result = await call('mcp_servers_update', { id, enabled: true })
    expect(result.isError).toBe(true)
    expect((await service.snapshot()).servers[0]!.enabled).toBe(false)
    await close()
  })

  it('refuses more than 20 servers in one call', async () => {
    const { call, close } = await connect(['mcp_servers'])
    const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`s${i}`, { command: 'x' }]))
    expect((await call('mcp_servers_add', { config: JSON.stringify({ mcpServers: many }) })).isError).toBe(true)
    expect((await service.snapshot()).servers).toEqual([])
    await close()
  })
})
