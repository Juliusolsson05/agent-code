import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'

import { assertFetchableTarget, netFetch, type NetFetchRequest } from './netFetch.js'

// The policy table is the contract; one real loopback round-trip proves the
// brokered path (headers, body, status, bounded response) end-to-end.

const servers: Array<ReturnType<typeof createServer>> = []
afterEach(() => { for (const server of servers.splice(0)) server.close() })

async function loopbackUpstream(): Promise<number> {
  const server = createServer((req, res) => {
    if (req.url === '/big') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('x'.repeat(300 * 1024)); return }
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk })
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ url: req.url, method: req.method, body, accept: req.headers.accept }))
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

describe('net.fetch target policy', () => {
  it('accepts a private literal with a port', () => {
    expect(assertFetchableTarget('http://192.168.1.42:5192/api', {} as NetFetchRequest).hostname).toBe('192.168.1.42')
    expect(assertFetchableTarget('http://[::1]:8080/', {} as NetFetchRequest).hostname).toBe('[::1]')
  })

  it.each([
    ['public literal', 'http://8.8.8.8/dns'],
    ['dns name', 'https://example.test/'],
    ['even localhost by name', 'http://localhost:5192/'],
    ['non-http scheme', 'file:///etc/passwd'],
    ['relative path', 'api/state'],
  ])('rejects %s before any socket opens', (_label, url) => {
    expect(() => assertFetchableTarget(url, {} as NetFetchRequest)).toThrow()
  })

  it('rejects CONNECT-shaped verbs and oversized declared bodies', () => {
    expect(() => assertFetchableTarget('http://127.0.0.1/x', { httpMethod: 'CONNECT' } as NetFetchRequest)).toThrow(/upgrades|tunnels|httpMethod/i)
    expect(() => assertFetchableTarget('http://127.0.0.1/x', { body: 'x'.repeat(65 * 1024) } as NetFetchRequest)).toThrow(/bytes/)
  })
})

describe('brokered net.fetch', () => {
  it('round-trips through the host to a loopback upstream', async () => {
    const port = await loopbackUpstream()
    const result = await netFetch({
      url: `http://127.0.0.1:${port}/api/state?code=1`,
      httpMethod: 'POST',
      headers: [{ name: 'Accept', value: 'application/json' }],
      body: '{"hello":1}',
    })
    expect(result.status).toBe(200)
    expect(result.contentType).toBe('application/json')
    expect(JSON.parse(result.body)).toEqual({ url: '/api/state?code=1', method: 'POST', body: '{"hello":1}', accept: 'application/json' })
  })

  it('caps the response before it crosses back into a sandboxed frame', async () => {
    const port = await loopbackUpstream()
    await expect(netFetch({ url: `http://127.0.0.1:${port}/big` })).rejects.toThrow(/responses are limited/)
  })
})
