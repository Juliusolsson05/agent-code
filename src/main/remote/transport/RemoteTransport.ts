import type { Server } from 'node:http'

// The reachability seam for the remote mobile companion (spec §"RemoteTransport").
//
// RemoteServer owns WHAT is served (HTTP routes, the WS endpoint, auth);
// a transport owns HOW the server becomes reachable and WHICH URL a phone
// should use. Splitting these means phase 2's cloudflared tunnel is a new
// transport implementation, not a server change:
//
//   - LanTransport (phase 1): bind the LAN interface, URL = http://<ip>:<port>
//   - CloudflaredTunnel (phase 2): bind loopback, spawn bundled cloudflared
//     against it, URL = the ephemeral https://…trycloudflare.com it prints
//
// The transport binds the *given* server rather than creating its own so the
// server's request/upgrade handlers are wired exactly once, by RemoteServer,
// regardless of transport.

export interface RemoteTransport {
  /** Make `server` reachable. Resolves with the URL to encode in the pairing QR. */
  start(server: Server): Promise<{ url: string }>
  /** Tear down reachability (close listener, kill tunnel child, …). Idempotent. */
  stop(): Promise<void>
}
