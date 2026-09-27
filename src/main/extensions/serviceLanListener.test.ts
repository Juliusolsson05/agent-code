import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import { TRANSPORT_ATTESTATION_HEADER } from '../../../packages/agent-code-extension-api/dist/service.js'
import { startServiceLanListener, type LanListenerHandle } from './serviceLanListener.js'

// The LAN listener is the host half of a cross-repo contract (#1147): a
// service with loopback-only rules decides who is local,
// who is a guest, and whether a POST is same-origin purely from what this
// listener forwards. So these tests use REAL sockets end to end — a real
// upstream records exactly what arrived on the wire, which is the only
// observable a service has. Peers here connect from 127.0.0.1, which the
// listener's private-source rule admits.

type Seen = { method?: string; url?: string; headers: IncomingHttpHeaders; body: string }

let upstream: Server | null = null
let listener: LanListenerHandle | null = null

afterEach(async () => {
  await listener?.close().catch(() => undefined)
  listener = null
  await new Promise<void>(resolve => (upstream ? upstream.close(() => resolve()) : resolve()))
  upstream = null
})

// WHY `GET /` is not recorded (#1409 / #1452 review b): when this suite runs
// inside an Agent Code lane, the browser pocket's LanePortWatcher finds both
// sockets in the lane's process tree. Once one has listened for its 5 s settle
// window (only a stalled run gets that far), the watcher sends it one `GET /`.
// Aimed at the LAN listener, that request is forwarded here WITHOUT its
// identifying User-Agent, because the listener's header allow-list drops it,
// correctly. So the upstream cannot tell the probe by header. It can tell it
// by shape: `send()` below never uses `/`, so no request this suite makes is
// `GET /`. Residual: a forwarding regression that emits an extra `GET /`
// would be excused. Any other extra request still fails `toHaveLength(1)`.
const WATCHER_PROBE_PATH = '/'
const TEST_PATH = '/lan-contract'

async function wire(responseHeaders: Record<string, string> = {}): Promise<{ seen: Seen[]; port: number }> {
  const seen: Seen[] = []
  upstream = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      if (!(req.method === 'GET' && req.url === WATCHER_PROBE_PATH)) seen.push({ method: req.method, url: req.url, headers: req.headers, body })
      res.writeHead(200, { 'content-type': 'application/json', ...responseHeaders })
      res.end('{"ok":true}')
    })
  })
  await new Promise<void>(resolve => upstream!.listen(0, '127.0.0.1', () => resolve()))
  listener = await startServiceLanListener((upstream.address() as AddressInfo).port)
  return { seen, port: listener.port }
}

/** node:http, not fetch: fetch would refuse to let the test forge Host or
 *  forwarding headers, and a hostile LAN peer is under no such restriction. */
function send(port: number, options: { method?: string; path?: string; headers?: Record<string, string>; body?: string }) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method: options.method ?? 'GET', path: options.path ?? TEST_PATH, headers: options.headers }, res => {
      let body = ''
      res.on('data', chunk => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end(options.body)
  })
}

describe('service LAN listener forwarding contract', () => {
  it('forwards the caller identity a bearer-token service needs, stamped with forwarding facts', async () => {
    const { seen, port } = await wire()
    const response = await send(port, {
      method: 'POST', path: '/api/action',
      headers: {
        host: `192.168.1.42:${port}`,
        origin: `http://192.168.1.42:${port}`,
        'sec-fetch-site': 'same-origin',
        authorization: 'Bearer token',
        'content-type': 'application/json',
        accept: 'application/json',
        cookie: 'session=secret',
        'x-evil': '1',
      },
      body: '{"kind":"check"}',
    })
    expect(response.status).toBe(200)
    expect(seen).toHaveLength(1)
    const headers = seen[0]!.headers
    expect(seen[0]!.body).toBe('{"kind":"check"}')
    expect(headers.authorization).toBe('Bearer token')
    expect(headers.origin).toBe(`http://192.168.1.42:${port}`)
    expect(headers['sec-fetch-site']).toBe('same-origin')
    expect(headers[TRANSPORT_ATTESTATION_HEADER]).toBe('lan')
    // The socket peer, with the dual-stack ::ffff: prefix removed.
    expect(headers['x-forwarded-for']).toBe('127.0.0.1')
    // The Host the peer used — what its browser's Origin must match.
    expect(headers['x-forwarded-host']).toBe(`192.168.1.42:${port}`)
    // Services key "did this really come from the listener?" on the Host it
    // dials with (the SDK tells services to trust `lan` only with exactly this
    // Host), so it is
    // part of the contract, not a Node default we happen to inherit.
    expect(headers.host).toBe(`127.0.0.1:${(upstream!.address() as AddressInfo).port}`)
    expect(headers.cookie).toBeUndefined()
    expect(headers['x-evil']).toBeUndefined()
  })

  // #1452 review b's failure sequence, on real sockets: the lane port watcher's
  // probe reaches the LAN listener mid-test, loses its User-Agent in
  // forwarding, and must not turn the contract's one request into two.
  it('a lane port watcher probe forwarded mid-test does not count as a contract request', async () => {
    const { seen, port } = await wire()
    await send(port, { method: 'GET', path: '/', headers: { 'user-agent': 'AgentCode-LanePortProbe/1' } })
    await send(port, { method: 'POST', body: '{"kind":"check"}', headers: { 'content-type': 'application/json' } })
    expect(seen.map(s => `${s.method} ${s.url}`)).toEqual(['POST /lan-contract'])
  })

  // The security property the whole contract rests on: a guest must not be
  // able to claim it is the host's own frame, or pose as another address.
  it('a LAN peer cannot forge the attestation or forwarding facts', async () => {
    const { seen, port } = await wire()
    await send(port, {
      headers: {
        host: `192.168.1.42:${port}`,
        [TRANSPORT_ATTESTATION_HEADER]: 'service',
        'x-forwarded-for': '127.0.0.1, 10.9.9.9',
        'x-forwarded-host': `127.0.0.1:${port}`,
      },
    })
    const headers = seen[0]!.headers
    expect(headers[TRANSPORT_ATTESTATION_HEADER]).toBe('lan')
    expect(headers['x-forwarded-for']).toBe('127.0.0.1')
    expect(headers['x-forwarded-host']).toBe(`192.168.1.42:${port}`)
  })

  it("carries the service's restricting security headers back to the LAN browser", async () => {
    const { port } = await wire({
      'content-security-policy': "default-src 'none'",
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
      'set-cookie': 'tracker=1',
      'access-control-allow-origin': '*',
    })
    const response = await send(port, {})
    expect(response.headers['content-security-policy']).toBe("default-src 'none'")
    expect(response.headers['x-content-type-options']).toBe('nosniff')
    expect(response.headers['referrer-policy']).toBe('no-referrer')
    expect(response.headers['x-frame-options']).toBe('DENY')
    expect(response.headers['cache-control']).toBe('no-store')
    // Anything that could WIDEN the browser's trust stays behind.
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(response.headers['access-control-allow-origin']).toBeUndefined()
  })
})
