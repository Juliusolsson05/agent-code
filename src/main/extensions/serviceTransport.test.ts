import { afterEach, describe, expect, it, vi } from 'vitest'

// The transport proxy is a trust boundary in its own right: it is the only
// network-shaped thing a sandboxed frame can reach. These tests pin the three
// denials that boundary exists for (no grant, no running service, no method
// upgrade) plus the pass-through shape, with fetch entirely faked.

const {
  configureServiceTransport,
  clearServiceTransport,
  isServiceTransportPath,
  proxyServiceTransportRequest,
  TRANSPORT_ATTESTATION_HEADER,
} = await import('./serviceTransport.js')

type Probe = { url: string; init?: RequestInit }

function wire(options: {
  granted?: boolean
  port?: number | null
  serviceId?: string
  respond?: (probe: Probe) => Response
}): Probe[] {
  const probes: Probe[] = []
  configureServiceTransport({
    hasCapability: async () => options.granted ?? true,
    // Endpoint resolution honors the service id like the real host: only the
    // owner's declared+running service has a port, everything else is null.
    serviceEndpoint: (_extensionId, serviceId) =>
      serviceId === (options.serviceId ?? 'timer.host') ? (options.port === undefined ? 5192 : options.port) : null,
    fetch: async (input, init) => {
      probes.push({ url: String(input), init })
      return options.respond?.({ url: String(input), init }) ?? new Response('pong', { status: 200, headers: { 'content-type': 'text/plain' } })
    },
  })
  return probes
}

const request = (method = 'GET', path = '__service/timer.host/api/state', body?: string, headers?: Record<string, string>) =>
  new Request(`agent-code-ext://timer/__bundle/gen-1/${path}${body ? '' : ''}`, {
    method,
    ...(body !== undefined ? { body, headers: { 'content-type': 'text/plain', ...headers } } : { headers }),
  })

afterEach(() => { clearServiceTransport(); vi.restoreAllMocks() })

describe('service.transport proxy', () => {
  it('forwards a granted request to the loopback endpoint and streams the answer back', async () => {
    const probes = wire({ granted: true, port: 5192 })
    const response = await proxyServiceTransportRequest('timer', 'gen-1', '__service/timer.host/api/state?x=1', request())
    expect(response?.status).toBe(200)
    expect(await response?.text()).toBe('pong')
    expect(probes).toEqual([{ url: 'http://127.0.0.1:5192/api/state?x=1', init: expect.objectContaining({ method: 'GET' }) }])
  })

  it('rejects methods that could smuggle an upgrade or a tunnel', async () => {
    wire({ granted: true })
    // The Request constructor itself refuses CONNECT, so probe with the minimal
    // surface the proxy consumes — it must gate on the method BEFORE any use.
    const connect = { method: 'CONNECT', url: 'agent-code-ext://timer/__bundle/gen-1/__service/timer.host/x', headers: new Headers(), body: null } as unknown as Request
    const response = await proxyServiceTransportRequest('timer', 'gen-1', '__service/timer.host/x', connect)
    expect(response?.status).toBe(405)
  })

  it('an ungranted extension learns nothing: same 404 as a missing page', async () => {
    const probes = wire({ granted: false })
    const response = await proxyServiceTransportRequest('timer', 'gen-1', '__service/timer.host/api/state', request())
    expect(response?.status).toBe(404)
    expect(probes).toEqual([])
  })

  it('a granted caller whose service is not running gets actionable copy, still no fetch', async () => {
    const probes = wire({ granted: true, port: null })
    const response = await proxyServiceTransportRequest('timer', 'gen-1', '__service/timer.host/api/state', request())
    expect(response?.status).toBe(404)
    expect(await response?.text()).toContain('not running')
    expect(probes).toEqual([])
  })

  it('another extension id can never be addressed through this origin', async () => {
    const probes = wire({ granted: true, port: 5192 })
    // The scheme handler derives the owner from the origin host; the proxy
    // treats the FIRST path segment as the service id. A forged id belonging to
    // a different extension has no running service under THIS owner and dies at
    // the endpoint lookup — no fetch, no oracle.
    const response = await proxyServiceTransportRequest('timer', 'gen-1', '__service/other.host/api', request())
    expect(response?.status).toBe(404)
    expect(probes).toEqual([])
  })

  it('bounds a declared oversized body before dialing', async () => {
    const probes = wire({ granted: true })
    const big = new Request('agent-code-ext://timer/__bundle/gen-1/__service/timer.host/upload', {
      method: 'POST', body: 'x'.repeat(16), headers: { 'content-length': String(2 * 1024 * 1024), 'content-type': 'text/plain' },
    })
    const response = await proxyServiceTransportRequest('timer', 'gen-1', '__service/timer.host/upload', big)
    expect(response?.status).toBe(413)
    expect(probes).toEqual([])
  })

  // The cross-repo contract (#1147): Agent Code Poker's server/http.ts reads
  // exactly this header set. A bearer-token service must see the frame's token,
  // and must be told — by the host, not the caller — that the request came
  // from its own extension's frame.
  it('forwards accept, content-type and authorization, plus the host attestation — nothing else', async () => {
    const probes = wire({ granted: true })
    const probe = new Request('agent-code-ext://timer/__bundle/gen-1/__service/timer.host/x', {
      method: 'POST', body: 'hi', headers: {
        accept: 'application/json', 'content-type': 'text/plain', authorization: 'Bearer abc',
        cookie: 'session=secret', 'x-evil': '1',
      },
    })
    await proxyServiceTransportRequest('timer', 'gen-1', '__service/timer.host/x', probe)
    const forwarded = probes[0]!.init!.headers as Headers
    // forEach, not entries(): the main project's lib has no DOM.Iterable.
    const all: Record<string, string> = {}
    forwarded.forEach((value, name) => { all[name] = value })
    expect(all).toEqual({
      accept: 'application/json',
      'content-type': 'text/plain',
      authorization: 'Bearer abc',
      [TRANSPORT_ATTESTATION_HEADER]: 'service',
    })
  })

  // The attestation is only worth anything if a caller cannot choose it. A frame
  // claiming `lan` (or supplying forwarding facts) would otherwise make a
  // service mis-classify its own host player, in either direction.
  it('a caller cannot forge the attestation or forwarding facts', async () => {
    const probes = wire({ granted: true })
    const probe = new Request('agent-code-ext://timer/__bundle/gen-1/__service/timer.host/x', {
      method: 'GET', headers: { [TRANSPORT_ATTESTATION_HEADER]: 'lan', 'x-forwarded-for': '10.0.0.9', 'x-forwarded-host': 'evil:1', origin: 'http://evil' },
    })
    await proxyServiceTransportRequest('timer', 'gen-1', '__service/timer.host/x', probe)
    const forwarded = probes[0]!.init!.headers as Headers
    expect(forwarded.get(TRANSPORT_ATTESTATION_HEADER)).toBe('service')
    expect(forwarded.get('x-forwarded-for')).toBeNull()
    expect(forwarded.get('x-forwarded-host')).toBeNull()
    expect(forwarded.get('origin')).toBeNull()
  })

  it('an upstream dial failure reads as not-running, not a proxy crash', async () => {
    wire({
      granted: true,
      respond: () => { throw new Error('ECONNREFUSED') },
    })
    const response = await proxyServiceTransportRequest('timer', 'gen-1', '__service/timer.host/api/state', request())
    expect(response?.status).toBe(404)
    expect(await response?.text()).toContain('not running')
  })

  it('non-service paths are not transport paths', async () => {
    wire({ granted: true })
    expect(isServiceTransportPath('dist/index.js')).toBe(false)
    expect(isServiceTransportPath('__service/timer.host/api')).toBe(true)
  })
})
