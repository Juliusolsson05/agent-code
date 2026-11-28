import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { expect, it, vi } from 'vitest'
import { BuiltInMcpHttpHost } from '@mcp/runtime/BuiltInMcpHttpHost.js'
import { TldrStore } from '@main/tldr/TldrStore.js'
import { openAntigravityNativeMcp } from './nativeMcp.js'

vi.mock('@main/performance/PerformanceService.js', () => ({ performanceService: { record: vi.fn() } }))

// A real upstream and the very executable/config that agy consumes. Checking a generated
// JSON shape alone missed both the absent native wiring and leaked environment credentials.
it('keeps two concurrent panes and their upstream credentials separate through real discovery and calls', async () => {
  const calls: Array<[string, string | undefined]> = []
  const host = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const method = req.method === 'POST' && JSON.parse(body).method
    if (!method || method === 'notifications/initialized') { res.writeHead(method ? 202 : 405).end(); return }
    const { id } = JSON.parse(body)
    calls.push([method, req.headers.authorization])
    const result = method === 'initialize'
      ? { protocolVersion: '2025-06-18', serverInfo: { name: 'fixture', version: '1' }, capabilities: { tools: {} } }
      : method === 'tools/list'
        ? { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }
        : { content: [{ type: 'text', text: 'received by ' + req.headers.authorization }] }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, result }))
  })
  await new Promise<void>(ok => host.listen(0, '127.0.0.1', ok))
  const address = host.address()
  if (!address || typeof address === 'string') throw Error('fixture failed to listen')
  const url = 'http://127.0.0.1:' + address.port
  const resources: Array<NonNullable<Awaited<ReturnType<typeof openAntigravityNativeMcp>>>> = []
  const clients: Client[] = []
  try {
    for (const bearerToken of ['first-only', 'second-only']) {
      const pane = await openAntigravityNativeMcp({ cwd: process.cwd(), builtInMcpServers: [{ name: 'agent_code', url, bearerToken, headers: {} }] })
      if (!pane) throw Error('missing registration')
      resources.push(pane)
      pane.setOwner(process.pid)
      const configText = await readFile(join(pane.directory, '.agents/mcp_config.json'), 'utf8')
      const config = JSON.parse(configText).mcpServers.agent_code
      expect(configText).not.toContain(bearerToken)
      const client = new Client({ name: 'test', version: '1' })
      clients.push(client)
      await client.connect(new StdioClientTransport({ ...config, env: config.env }))
      expect((await client.listTools()).tools.map(t => t.name)).toEqual(['echo'])
      expect(await client.callTool({ name: 'echo' })).toMatchObject({ content: [{ text: 'received by Bearer ' + bearerToken }] })
    }
    const wrong = new Client({ name: 'wrong-pane', version: '1' })
    clients.push(wrong)
    const firstConfig = JSON.parse(await readFile(join(resources[0]!.directory, '.agents/mcp_config.json'), 'utf8')).mcpServers.agent_code
    resources[0]!.setOwner(process.pid + 1)
    await expect(wrong.connect(new StdioClientTransport(firstConfig))).rejects.toThrow()
    resources[0]!.close()
    await expect(readFile(join(resources[0]!.directory, '.agents/mcp_config.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await clients[1]!.callTool({ name: 'echo' })).toMatchObject({ content: [{ text: 'received by Bearer second-only' }] })
    expect(calls.filter(([m]) => m === 'tools/call')).toEqual([
      ['tools/call', 'Bearer first-only'], ['tools/call', 'Bearer second-only'], ['tools/call', 'Bearer second-only'],
    ])
  } finally {
    for (const pane of resources) pane.close()
    await Promise.all(clients.map(client => client.close()))
    host.closeAllConnections()
    await new Promise<void>(ok => host.close(() => ok()))
  }
})

it('does not create a workspace or listener for a pane without grants', async () => {
  expect(await openAntigravityNativeMcp({ cwd: process.cwd() })).toBeUndefined()
})

it('passes managed stdio secrets only to their own server and keeps relay grants outside the attached workspace', async () => {
  const fixture = String.raw`
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      const { id, method } = JSON.parse(line)
      if (id === undefined) return
      const result = method === 'initialize'
        ? { protocolVersion: '2025-06-18', serverInfo: { name: 'env', version: '1' }, capabilities: { tools: {} } }
        : { content: [{ type: 'text', text: JSON.stringify({
          own: process.env.MCP_FIXTURE_SECRET,
          inheritedBootstrap: Boolean(process.env.AGENT_CODE_AGY_RELAY_BOOTSTRAP),
          cwd: process.cwd()
        }) }] }
      console.log(JSON.stringify({ jsonrpc: '2.0', id, result }))
    })`
  const pane = await openAntigravityNativeMcp({ cwd: process.cwd(), userMcpServers: [
    { name: 'server_a', id: '1', entry: { command: process.execPath, args: ['-e', fixture], env: { MCP_FIXTURE_SECRET: '${input:key}' } }, secrets: { key: 'isolated-stdio-value' } },
  ] })
  if (!pane) throw Error('missing managed registration')
  const client = new Client({ name: 'native', version: '1' })
  try {
    pane.setOwner(process.pid)
    const disk = await readFile(join(pane.directory, '.agents/mcp_config.json'), 'utf8')
    expect(disk).not.toContain('isolated-stdio-value')
    const entry = JSON.parse(disk).mcpServers.server_a
    const bootstrap: string = entry.env.AGENT_CODE_AGY_RELAY_BOOTSTRAP
    expect(bootstrap.startsWith(pane.directory + '/')).toBe(false)
    expect((await readFile(bootstrap)).length).toBe(32)
    await client.connect(new StdioClientTransport(entry))
    expect(await client.callTool({ name: 'check' })).toMatchObject({
      content: [{ text: JSON.stringify({ own: 'isolated-stdio-value', inheritedBootstrap: false, cwd: process.cwd() }) }],
    })
    pane.close()
    await expect(readFile(bootstrap)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    pane.close()
    await client.close()
  }
})

it('writes a real TLDR record through the native bridge with the scope of its registered pane', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agy-mcp-tldr-'))
  const store = new TldrStore(join(directory, 'tldr.json'))
  const host = new BuiltInMcpHttpHost()
  const client = new Client({ name: 'native', version: '1' })
  let pane: Awaited<ReturnType<typeof openAntigravityNativeMcp>>
  try {
    host.setDependencies({ tldrStore: store })
    await host.start()
    const cwd = process.cwd()
    const builtInMcpServers = host.registerSession({ sessionId: 'native-test', tldrIdentity: 'this-pane', providerKind: 'antigravity', cwd, domains: ['tldr'] })
    pane = await openAntigravityNativeMcp({ cwd, builtInMcpServers })
    if (!pane) throw Error('missing built-in registration')
    pane.setOwner(process.pid)
    const entry = JSON.parse(await readFile(join(pane.directory, '.agents/mcp_config.json'), 'utf8')).mcpServers.agent_code
    await client.connect(new StdioClientTransport(entry))
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['tldr_update'])
    expect((await client.callTool({ name: 'tldr_update', arguments: { text: 'Verified native tools.' } })).isError).not.toBe(true)
    expect(await store.read(['this-pane', 'other-pane'])).toMatchObject({ 'this-pane': { text: 'Verified native tools.' } })
    expect(await store.read(['other-pane'])).toEqual({})
  } finally {
    await client.close()
    pane?.close()
    await host.stop()
    await rm(directory, { recursive: true, force: true })
  }
})

it('gives agy native HTTP endpoints for OAuth and keeps credential-bearing endpoint shapes off disk', async () => {
  const examples = [
    ['oauth', 'https://example.com/mcp'], ['root', 'https://oauth.example.com'],
    ['with_path', 'https://example.com/private-value'], ['query', 'https://example.com/mcp?key=private-value'],
    ['fragment', 'https://example.com/mcp#private-value'], ['userinfo', 'https://user:private-value@example.com/mcp'],
    ['normalized', 'https://example.com/private-value/../mcp'], ['insecure', 'http://example.com/mcp'],
  ] as const
  const pane = await openAntigravityNativeMcp({
    cwd: process.cwd(),
    userMcpServers: [
      ...examples.map(([name, url]) => ({ id: name, name, entry: { type: 'http' as const, url }, secrets: {} })),
      { id: 'headers', name: 'headers', entry: { type: 'http', url: 'https://example.com/mcp', headers: { 'X-Api-Key': 'private-value' } }, secrets: {} },
    ],
    builtInMcpServers: [{ name: 'agent_code', url: 'https://example.com/mcp', headers: {} }],
  })
  if (!pane) throw Error('missing workspace')
  try {
    const raw = await readFile(join(pane.directory, '.agents/mcp_config.json'), 'utf8')
    const entries = JSON.parse(raw).mcpServers
    expect(entries.oauth).toEqual({ serverUrl: 'https://example.com/mcp' })
    expect(entries.root).toEqual({ serverUrl: 'https://oauth.example.com' })
    expect(raw).not.toContain('private-value')
    for (const name of ['with_path', 'query', 'fragment', 'userinfo', 'normalized', 'insecure', 'headers', 'agent_code']) {
      // The settings layer may also reject an invalid URL before launch.
      if (name === 'userinfo' && !entries[name]) continue
      expect(entries[name]).toHaveProperty('command')
    }
  } finally { pane.close() }
})

it('closes a failed upstream launch and can reconnect the pane after the executable appears', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agy-missing-mcp-'))
  const command = join(directory, 'server')
  const pane = await openAntigravityNativeMcp({
    cwd: directory,
    userMcpServers: [{ id: 'recover', name: 'recover', entry: { command }, secrets: {} }],
  })
  if (!pane) throw Error('missing registration')
  const failed = new Client({ name: 'first', version: '1' })
  const recovered = new Client({ name: 'second', version: '1' })
  try {
    pane.setOwner(process.pid)
    const entry = JSON.parse(await readFile(join(pane.directory, '.agents/mcp_config.json'), 'utf8')).mcpServers.recover
    await expect(failed.connect(new StdioClientTransport(entry))).rejects.toThrow()
    await writeFile(command, `#!/usr/bin/env node
require('node:readline').createInterface({input: process.stdin}).on('line', line => {
  const { id, method } = JSON.parse(line)
  if (id === undefined) return
  const result = method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: {tools:{}}, serverInfo:{name:'recovered',version:'1'} } : {tools:[]}
  console.log(JSON.stringify({ jsonrpc: '2.0', id, result }))
})
`, { mode: 0o700 })
    await recovered.connect(new StdioClientTransport(entry))
    expect(await recovered.listTools()).toMatchObject({ tools: [] })
  } finally {
    await Promise.all([failed.close(), recovered.close()])
    pane.close()
    await rm(directory, { recursive: true, force: true })
  }
})
