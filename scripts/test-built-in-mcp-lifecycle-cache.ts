import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'

import {
  BuiltInMcpHttpHost,
  type BuiltInMcpDependencies,
} from '../src/mcp/runtime/BuiltInMcpHttpHost'
import type { McpSessionScope } from '../src/mcp/shared/types'

type Deferred = {
  promise: Promise<void>
  resolve: () => void
}

function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>(res => {
    resolve = res
  })
  return { promise, resolve }
}

type FakeServerRecord = {
  scope: McpSessionScope
  connectCount: number
  closeCount: number
}

function createFakeFactory(options: {
  delayResponse?: Deferred
} = {}): {
  records: FakeServerRecord[]
  factory: (scope: McpSessionScope, dependencies: BuiltInMcpDependencies) => McpServer
} {
  const records: FakeServerRecord[] = []
  return {
    records,
    factory: (scope: McpSessionScope) => {
      const record: FakeServerRecord = { scope, connectCount: 0, closeCount: 0 }
      records.push(record)
      return {
        async connect(transport: StreamableHTTPServerTransport): Promise<void> {
          record.connectCount += 1
          ;(transport as unknown as {
            handleRequest: (req: IncomingMessage, res: ServerResponse) => Promise<void>
          }).handleRequest = async (_req, res) => {
            if (options.delayResponse) await options.delayResponse.promise
            res.statusCode = 200
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({
              ok: true,
              sessionId: scope.sessionId,
              domains: scope.domains,
              connectCount: record.connectCount,
            }))
          }
        },
        async close(): Promise<void> {
          record.closeCount += 1
        },
      } as unknown as McpServer
    },
  }
}

async function requestJson(url: string, token?: string): Promise<{
  status: number
  body: unknown
}> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    }),
  })
  const text = await response.text()
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
  }
}

function tokenFromConfigUrl(url: string): string {
  const parsed = new URL(url)
  const token = parsed.searchParams.get('token')
  assert.ok(token)
  return token
}

{
  const { factory, records } = createFakeFactory()
  const host = new BuiltInMcpHttpHost(factory)
  await host.start()
  try {
    const configs = host.registerSession({
      sessionId: 'no-domains',
      cwd: '/repo',
      domains: [],
    })
    assert.deepEqual(configs, [])
    assert.equal(records.length, 0)
  } finally {
    await host.stop()
  }
}

{
  const { factory, records } = createFakeFactory()
  const host = new BuiltInMcpHttpHost(factory)
  await host.start()
  try {
    const [config] = host.registerSession({
      sessionId: 'session-a',
      cwd: '/repo',
      domains: ['orchestration'],
    })
    assert.ok(config)
    const token = tokenFromConfigUrl(config.url)
    assert.equal(records.length, 1)
    assert.equal(records[0]?.scope.sessionId, 'session-a')

    const first = await requestJson(config.url, token)
    const second = await requestJson(config.url, token)
    assert.equal(first.status, 200)
    assert.equal(second.status, 200)
    assert.equal(records.length, 1)
    assert.equal(records[0]?.connectCount, 2)
    assert.equal(records[0]?.closeCount, 0)

    host.revokeSession('session-a')
    const revoked = await requestJson(config.url, token)
    assert.equal(revoked.status, 401)
    assert.equal(records[0]?.closeCount, 1)
  } finally {
    await host.stop()
  }
}

{
  const { factory, records } = createFakeFactory()
  const host = new BuiltInMcpHttpHost(factory)
  await host.start()
  try {
    const [firstConfig] = host.registerSession({
      sessionId: 'session-a',
      cwd: '/repo',
      domains: ['agent_transcripts'],
    })
    const [secondConfig] = host.registerSession({
      sessionId: 'session-a',
      cwd: '/repo',
      domains: ['agent_transcripts'],
    })
    assert.ok(firstConfig)
    assert.ok(secondConfig)
    assert.notEqual(firstConfig.url, secondConfig.url)
    assert.equal(records.length, 2)
    assert.equal(records[0]?.closeCount, 1)
    assert.equal((await requestJson(firstConfig.url, tokenFromConfigUrl(firstConfig.url))).status, 401)
    assert.equal((await requestJson(secondConfig.url, tokenFromConfigUrl(secondConfig.url))).status, 200)
  } finally {
    await host.stop()
  }
}

{
  const delayResponse = deferred()
  const { factory, records } = createFakeFactory({ delayResponse })
  const host = new BuiltInMcpHttpHost(factory)
  await host.start()
  try {
    const [config] = host.registerSession({
      sessionId: 'session-a',
      cwd: '/repo',
      domains: ['ai_workspace'],
    })
    assert.ok(config)
    const request = requestJson(config.url, tokenFromConfigUrl(config.url))
    await new Promise(resolve => setTimeout(resolve, 10))
    host.revokeSession('session-a')
    assert.equal(records[0]?.closeCount, 0)
    delayResponse.resolve()
    assert.equal((await request).status, 200)
    assert.equal(records[0]?.closeCount, 1)
  } finally {
    await host.stop()
  }
}

{
  const { factory } = createFakeFactory()
  const host = new BuiltInMcpHttpHost(factory)
  await host.start()
  try {
    host.registerSession({
      sessionId: 'session-a',
      cwd: '/repo',
      domains: ['orchestration'],
    })
    assert.throws(() => host.setDependencies({}), /must be set before sessions register/)
  } finally {
    await host.stop()
  }
}

{
  const { factory, records } = createFakeFactory()
  const host = new BuiltInMcpHttpHost(factory)
  await host.start()
  const [first] = host.registerSession({
    sessionId: 'session-a',
    cwd: '/repo',
    domains: ['orchestration'],
  })
  const [second] = host.registerSession({
    sessionId: 'session-b',
    cwd: '/repo',
    domains: ['ai_workspace'],
  })
  assert.ok(first)
  assert.ok(second)
  await host.stop()
  assert.equal(records.length, 2)
  assert.equal(records[0]?.closeCount, 1)
  assert.equal(records[1]?.closeCount, 1)
}

console.log('built-in MCP lifecycle cache tests passed')
