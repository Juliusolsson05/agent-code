import { createServer, type IncomingMessage, type ServerResponse, type ClientRequest } from 'node:http'
import { request as upstreamRequest } from 'node:http'
import type { Socket } from 'node:net'

import { isPrivateIpLiteral } from './netPolicy.js'

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
  // undefined header value, and a plain GET carries neither of these.
  const headers: Record<string, string> = {}
  const accept = req.headers.accept
  const contentType = req.headers['content-type']
  if (accept !== undefined) headers.accept = accept
  if (contentType !== undefined) headers['content-type'] = contentType

  const upstream: ClientRequest = upstreamRequest(
    { host: '127.0.0.1', port: targetPort, method: req.method, path: req.url, headers },
    response => {
      res.writeHead(response.statusCode ?? 502, { 'content-type': response.headers['content-type'] ?? 'application/octet-stream', 'cache-control': 'no-store' })
      response.pipe(res)
    },
  )
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(502).end(); else res.destroy() })
  req.pipe(upstream)
}

/** Factory seam for serviceHost tests: fake listeners without real sockets. */
export const realLanListener: LanListenerFactory = targetPort => startServiceLanListener(targetPort)
