import type { Server } from 'node:http'
import { networkInterfaces } from 'node:os'

import type { RemoteTransport } from '@main/remote/transport/RemoteTransport.js'

// Phase-1 transport: plain LAN reachability. Binds 0.0.0.0 so any interface
// works (Wi-Fi vs Ethernet vs USB tether), but the QR URL uses one concrete
// LAN IPv4 because a phone can't dial 0.0.0.0.

/**
 * Pick the address a phone on the same network can reach. First
 * non-internal IPv4 wins; interface map is injectable for tests.
 *
 * WHY loopback fallback instead of throwing when the machine has no LAN
 * address: the remote panel should still render (showing 127.0.0.1 makes
 * the "you are not on a network" failure visible and debuggable), and the
 * phase-2 tunnel transport doesn't need a LAN address at all.
 */
export function pickLanIpv4(
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): string {
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address
    }
  }
  return '127.0.0.1'
}

export class LanTransport implements RemoteTransport {
  private server: Server | null = null
  private readonly port: number

  /** port 0 = OS-assigned. A fixed default port is deliberately NOT chosen
   *  yet: the URL travels by QR, so nobody types it, and a floating port
   *  avoids colliding with dev servers. Revisit if re-pairing friction
   *  shows up (a stable port would let old QR screenshots keep working). */
  constructor(opts: { port?: number } = {}) {
    this.port = opts.port ?? 0
  }

  async start(server: Server): Promise<{ url: string }> {
    this.server = server
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        server.off('listening', onListening)
        reject(err)
      }
      const onListening = (): void => {
        server.off('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      // 0.0.0.0, not the picked IP: binding one interface would silently
      // break when the user hops networks mid-session; the QR regenerates
      // per enable anyway.
      server.listen(this.port, '0.0.0.0')
    })

    const address = this.server.address()
    if (!address || typeof address === 'string') {
      throw new Error('LanTransport: server did not bind a TCP port')
    }
    return { url: `http://${pickLanIpv4()}:${address.port}` }
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    if (!server || !server.listening) return
    await new Promise<void>(resolve => {
      // close() waits for open sockets; closeAllConnections force-drops live
      // WS clients so disable is immediate — a lingering socket on a server
      // the user just turned OFF would be a broken promise about the toggle.
      server.closeAllConnections?.()
      server.close(() => resolve())
    })
  }
}
