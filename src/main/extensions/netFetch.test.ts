import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'

import { assertFetchableTarget, MAX_NET_FETCH_RESPONSE_BYTES, netFetch, type NetFetchRequest } from './netFetch.js'

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

  // #1147 review blocker: services trust x-agent-code-transport and
  // x-forwarded-* on a loopback socket because only the host sets them. A
  // net.connect extension that could send them would pose as another
  // extension's own frame (`service`) or as any LAN guest (`lan` + forged
  // peer), e.g. to take the Poker host seat.
  it.each([
    ['the service attestation', 'x-agent-code-transport', 'service'],
    ['the lan attestation', 'X-Agent-Code-Transport', 'lan'],
    ['a forged forwarded peer', 'x-forwarded-for', '127.0.0.1'],
    ['a forged forwarded host', 'X-Forwarded-Host', '192.168.1.42:61234'],
    ['the RFC 7239 form', 'Forwarded', 'for=127.0.0.1'],
  ])('refuses a caller who supplies %s, before any socket opens', async (_label, name, value) => {
    let dialed = false
    const perform = (async () => { dialed = true; return new Response('{}') }) as typeof fetch
    await expect(netFetch({ url: 'http://192.168.1.42:5192/api/create', httpMethod: 'POST', headers: [{ name, value }] }, perform))
      .rejects.toThrow(/reserved for the Agent Code host/)
    expect(dialed).toBe(false)
  })

  // Even without forged headers, a direct loopback fetch to a service port
  // skips the proxy and listener entirely: another extension could supply its
  // own Origin and look like the service's same-origin local page.
  it.each([
    ['127.0.0.1', 'http://127.0.0.1:5192/api/create'],
    ['another 127/8 address', 'http://127.4.5.6:5192/api/create'],
    ['IPv6 loopback', 'http://[::1]:5192/api/create'],
  ])('refuses a host-owned service or listener port on %s', async (_label, url) => {
    let dialed = false
    const perform = (async () => { dialed = true; return new Response('{}') }) as typeof fetch
    await expect(netFetch({ url }, perform, { isHostOwnedLoopbackPort: port => port === 5192 }))
      .rejects.toThrow(/cannot reach Agent Code extension services/)
    expect(dialed).toBe(false)
  })

  it('the IPv4-mapped loopback form never gets as far as the port check', () => {
    // URL() rewrites [::ffff:127.0.0.1] to [::ffff:7f00:1], which the address
    // policy already refuses, so this spelling is not a way around the port rule.
    expect(() => assertFetchableTarget('http://[::ffff:127.0.0.1]:5192/', {} as NetFetchRequest)).toThrow(/private local-network/)
  })

  it('still reaches other loopback ports and the same port on a LAN address', async () => {
    const port = await loopbackUpstream()
    const guards = { isHostOwnedLoopbackPort: (candidate: number) => candidate === port + 1 }
    expect((await netFetch({ url: `http://127.0.0.1:${port}/ok` }, fetch, guards)).status).toBe(200)
    // A LAN-address target is a friend's host (or this machine's listener,
    // which stamps the caller) — not a way around the proxy.
    expect(() => assertFetchableTarget(`http://192.168.1.42:${port + 1}/`, {} as NetFetchRequest, guards)).not.toThrow()
  })

  it('caps the response before it crosses back into a sandboxed frame', async () => {
    const port = await loopbackUpstream()
    await expect(netFetch({ url: `http://127.0.0.1:${port}/big` })).rejects.toThrow(/responses are limited/)
  })

  it('stops reading a streamed body with no Content-Length at the cap (text and base64)', async () => {
    for (const responseType of ['text', 'base64'] as const) {
      let pulled = 0, cancelled = false
      const chunk = new Uint8Array(64 * 1024)
      const perform = (async () => new Response(new ReadableStream<Uint8Array>({
        pull(controller) { pulled += chunk.byteLength; controller.enqueue(chunk) }, cancel() { cancelled = true },
      }))) as unknown as typeof fetch
      await expect(netFetch({ url: 'http://192.168.1.20:5192/big', responseType }, perform)).rejects.toThrow(/limited/)
      expect(cancelled).toBe(true)
      expect(pulled).toBeLessThanOrEqual(MAX_NET_FETCH_RESPONSE_BYTES + 4 * chunk.byteLength)
    }
  })
})
