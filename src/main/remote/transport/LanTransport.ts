import type { Server } from 'node:http'
import { networkInterfaces } from 'node:os'

import type { RemoteTransport } from '@main/remote/transport/RemoteTransport.js'

// Phase-1 transport: plain LAN reachability. Binds 0.0.0.0 so any interface
// works (Wi-Fi vs Ethernet vs USB tether), but the QR URL uses one concrete
// LAN IPv4 because a phone can't dial 0.0.0.0.

// Interfaces that are almost never what a phone on the same Wi-Fi can
// route to: VPN tunnels (utun/tun/tap/tailscale/zt), Apple's peer-to-peer
// links (awdl/llw), and VM/container bridges (bridge/vmnet/docker/veth).
// Enumeration order from networkInterfaces() is arbitrary, and a first-hit
// scan regularly baked a VPN address into the pairing QR whenever a
// corporate VPN or Docker Desktop was running (review finding) — the phone
// then couldn't reach the URL despite being on the same network.
const VIRTUAL_INTERFACE = /^(utun|tun|tap|tailscale|zt|awdl|llw|bridge|vmnet|docker|veth)/i
// macOS physical NICs are enN (Wi-Fi is usually en0); Linux dev boxes use
// eth*/wlan*. Preferring these is a ranking, not a filter — a machine with
// only exotic interface names still gets its best non-virtual address.
const PHYSICAL_INTERFACE = /^(en|eth|wlan)/i

/**
 * Pick the address a phone on the same network can reach, ranked:
 * physical-looking interfaces first, then any non-virtual, then anything
 * non-internal at all.
 *
 * WHY loopback fallback instead of throwing when the machine has no LAN
 * address: the remote panel should still render (showing 127.0.0.1 makes
 * the "you are not on a network" failure visible and debuggable), and the
 * phase-2 tunnel transport doesn't need a LAN address at all.
 */
export function pickLanIpv4(
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): string {
  const candidates: Array<{ name: string; address: string }> = []
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        candidates.push({ name, address: entry.address })
      }
    }
  }
  const physical = candidates.find(c => PHYSICAL_INTERFACE.test(c.name))
  if (physical) return physical.address
  const nonVirtual = candidates.find(c => !VIRTUAL_INTERFACE.test(c.name))
  if (nonVirtual) return nonVirtual.address
  return candidates[0]?.address ?? '127.0.0.1'
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
