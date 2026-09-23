import { createServer, type IncomingMessage, type ServerResponse, type ClientRequest } from 'node:http'
import { request as upstreamRequest } from 'node:http'
import type { Socket } from 'node:net'

import { isPrivateIpLiteral } from './netPolicy.js'
import { TRANSPORT_ATTESTATION_HEADER } from './serviceTransport.js'

// The net.listen half of host-owned LAN exposure. The service process binds
// LOOPBACK only; this listener is the single thing that makes it reachable from
// the local network, it lives in the host, and it closes when the service stops
// or the extension says so. A service therefore cannot make itself
// LAN-reachable on its own authority — exposure is a host decision under the
// net.listen grant.
//
// Even though the socket binds the unspecified address (that is what "expose on
// the LAN" means on a multi-interface machine), requests from non-private
// source addresses are dropped before any upstream byte is sent. A machine that
// also has a public interface stays unexposed on it.

const MAX_LAN_REQUEST_BYTES = 1024 * 1024

/** Peer headers that survive the listener (#1147). authorization lets a
 *  bearer-token service authenticate guests at all; origin and sec-fetch-site
 *  let the service apply ITS OWN same-origin/CSRF rule against the forwarded
 *  host below. Everything else — cookies, arbitrary x-*, and above all any
 *  peer-supplied x-forwarded-* or attestation header — is dropped by omission. */
const FORWARDED_REQUEST_HEADERS = ['accept', 'content-type', 'authorization', 'origin', 'sec-fetch-site'] as const

/** Service response headers carried back to the LAN browser. Each one only
 *  RESTRICTS what that browser does with the page, so forwarding can never
 *  widen anything; dropping them (the old behaviour) served the service's page
 *  to LAN browsers without its CSP, nosniff or framing protection. */
const FORWARDED_RESPONSE_HEADERS = ['content-security-policy', 'x-content-type-options', 'referrer-policy', 'x-frame-options'] as const

export type LanListenerHandle = {
  readonly port: number
  close(): Promise<void>
}

export type LanListenerFactory = (targetPort: number) => Promise<LanListenerHandle>

function remoteHost(socket: Socket): string | null {
  return socket.remoteAddress ?? null
}

/**
 * Bind a reverse proxy for 127.0.0.1:<targetPort> on all interfaces, admitting
 * only private-source connections. Bound port is OS-chosen (0), so collisions
 * cannot be engineered; the caller reports it for display.
 */
export async function startServiceLanListener(
  targetPort: number,
  inject?: { create?: typeof createServer },
): Promise<LanListenerHandle> {
  const server = (inject?.create ?? createServer)((req: IncomingMessage, res: ServerResponse) => {
    void proxy(req, res, targetPort)
  })
  // Long-lived idle keep-alives from LAN peers would otherwise pin sockets after
  // close(); they get a bounded lifetime like the transport proxy's semantics.
  server.keepAliveTimeout = 5000
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, () => resolve())
  })
  const address = server.address()
  if (!address || typeof address !== 'object') {
    server.close()
    throw new Error('The LAN listener could not determine its port.')
  }
  return {
    port: address.port,
    async close() {
      await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())))
    },
  }
}

function proxy(req: IncomingMessage, res: ServerResponse, targetPort: number): void {
  const peer = remoteHost(req.socket)
  // The exposure promise is "private LAN", so enforcement lives HERE, at the
  // accept boundary — not in a firewall the app never edits. Public-source
  // connections see a plain close, identical to nothing listening.
  if (!peer || !isPrivateIpLiteral(peer)) { req.socket.destroy(); return }

  const declared = Number(req.headers['content-length'] ?? Number.NaN)
  if (Number.isFinite(declared) && declared > MAX_LAN_REQUEST_BYTES) {
    res.writeHead(413).end()
    return
  }

  // Header allow-list, undefined-filtered: Node's ClientRequest throws on an
  // undefined header value, and a plain GET carries none of the optional ones.
  const headers: Record<string, string> = {}
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = req.headers[name]
    if (typeof value === 'string') headers[name] = value
  }
  // WHY THE LISTENER STAMPS FORWARDING FACTS: it dials the service over
  // loopback, so without them every LAN guest arrives as 127.0.0.1 with Host
  // 127.0.0.1:<service port>. A service with "host-computer only" rules (the
  // poker table's loopback-only create) would then admit any guest as local,
  // and it could not check a guest browser's Origin against the address that
  // browser actually used. These are SET from the socket and request line —
  // the allow-list above never copies a peer's own x-forwarded-* or
  // attestation — so a peer can neither forge nor erase them.
  //
  // The attestation value `lan` is the DOWNGRADE half of the contract that
  // serviceTransport.ts's `service` value is the other half of: a service must
  // treat a `lan` request as the forwarded remote peer, never as local.
  headers[TRANSPORT_ATTESTATION_HEADER] = 'lan'
  // Dual-stack accept reports IPv4 peers as ::ffff:a.b.c.d; services compare
  // plain IPv4, so hand them the address the peer actually has.
  headers['x-forwarded-for'] = peer.replace(/^::ffff:/i, '')
  if (typeof req.headers.host === 'string') headers['x-forwarded-host'] = req.headers.host

  const upstream: ClientRequest = upstreamRequest(
    // Host is set explicitly, not inherited from Node's default: services use
    // "Host is exactly 127.0.0.1:<my port>" to tell the listener's `lan`
    // requests from a DNS-rebound page that also claims `lan` (#1147 review).
    { host: '127.0.0.1', port: targetPort, method: req.method, path: req.url, headers: { ...headers, host: `127.0.0.1:${targetPort}` } },
    response => {
      const passed: Record<string, string> = {}
      for (const name of FORWARDED_RESPONSE_HEADERS) {
        const value = response.headers[name]
        if (typeof value === 'string') passed[name] = value
      }
      res.writeHead(response.statusCode ?? 502, {
        ...passed,
        'content-type': response.headers['content-type'] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      })
      response.pipe(res)
    },
  )
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(502).end(); else res.destroy() })
  req.pipe(upstream)
}

/** Factory seam for serviceHost tests: fake listeners without real sockets. */
export const realLanListener: LanListenerFactory = targetPort => startServiceLanListener(targetPort)
