import { spawn, type ChildProcess } from 'node:child_process'
import type { Server } from 'node:http'

import type { RemoteTransport } from '@main/remote/transport/RemoteTransport.js'

// Phase-2 transport: reachability from anywhere via a Cloudflare quick
// tunnel. The server binds LOOPBACK ONLY — with a public tunnel up, also
// listening on the LAN would double the exposed surface for no benefit;
// the tunnel is the single way in, and disabling it severs everything.
//
// `cloudflared tunnel --url ...` without an account gives an ephemeral
// https://<random>.trycloudflare.com URL: no credentials, TLS + WS proxying
// included, URL dies with the process. The trade-offs (URL changes every
// enable, best-effort service, no uptime SLA) are acceptable for a single
// owner's phone and are stated in the Remote panel copy. A stable hostname
// needs a Cloudflare account + domain — deliberately out of v1 scope.
//
// The binary comes from third_party/cloudflared via the runtime-tools
// resolver (see that manifest's README). This transport takes the RESOLVED
// path: resolution policy (bundled-only, dev-cache fallback, no PATH
// lookup) belongs to the caller in main, not to a transport that tests
// drive with a fake shell script.

const TRYCLOUDFLARE_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/

/** Extract the quick-tunnel URL from a chunk of cloudflared stderr.
 *  Exported for the unit test — the log format is upstream's, not ours,
 *  so the fixture in the test is the contract record. */
export function parseTunnelUrl(chunk: string): string | null {
  // Guard against matching documentation URLs in unrelated log lines:
  // quick-tunnel hostnames are random dash-joined tokens under
  // trycloudflare.com specifically, which the regex pins.
  const match = TRYCLOUDFLARE_URL.exec(chunk)
  return match ? match[0] : null
}

export class CloudflaredTunnel implements RemoteTransport {
  private server: Server | null = null
  private child: ChildProcess | null = null
  private readonly binaryPath: string
  private readonly urlTimeoutMs: number

  constructor(opts: {
    binaryPath: string
    /** How long to wait for cloudflared to print the public URL before
     *  declaring the start failed. The real binary takes 1-5s; the default
     *  leaves headroom for slow first-run edge negotiation. */
    urlTimeoutMs?: number
  }) {
    this.binaryPath = opts.binaryPath
    this.urlTimeoutMs = opts.urlTimeoutMs ?? 30_000
  }

  async start(server: Server): Promise<{ url: string }> {
    this.server = server
    try {
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
        server.listen(0, '127.0.0.1')
      })

      const address = server.address()
      if (!address || typeof address === 'string') {
        throw new Error('CloudflaredTunnel: server did not bind a TCP port')
      }

      const url = await this.spawnAndAwaitUrl(address.port)
      return { url }
    } catch (err) {
      // Never leave a half-started transport: a listening loopback server
      // with no tunnel is dead weight, and a live child with no server is
      // an orphaned process. stop() is idempotent and handles both.
      await this.stop()
      throw err
    }
  }

  async stop(): Promise<void> {
    const child = this.child
    this.child = null
    if (child && child.exitCode === null && !child.killed) {
      // SIGTERM is enough: cloudflared shuts down its edge connections
      // cleanly on TERM. No SIGKILL escalation — an unkillable cloudflared
      // has never been observed, and the child is session-scoped anyway
      // (Electron main's exit reaps it).
      child.kill('SIGTERM')
    }
    const server = this.server
    this.server = null
    if (server?.listening) {
      await new Promise<void>(resolve => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      })
    }
  }

  private spawnAndAwaitUrl(port: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      // --no-autoupdate: the bundled binary's identity is pinned by the
      // third_party manifest; a self-updating copy would silently diverge
      // from the hashes we verified.
      const child = spawn(this.binaryPath, [
        'tunnel',
        '--url',
        `http://127.0.0.1:${port}`,
        '--no-autoupdate',
      ])
      this.child = child

      let settled = false
      let collected = ''
      const timer = setTimeout(() => {
        settle(() =>
          reject(
            new Error(
              `cloudflared did not print a tunnel URL within ${this.urlTimeoutMs}ms. ` +
                `Last output:\n${collected.slice(-500)}`,
            ),
          ),
        )
      }, this.urlTimeoutMs)

      const settle = (fn: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        // Stop accumulating output once settled — the child lives for the
        // whole tunnel session and chatty edge logs would otherwise grow
        // `collected` (and run the regex) for hours after start() resolved.
        child.stderr?.off('data', onChunk)
        child.stdout?.off('data', onChunk)
        fn()
      }

      const onChunk = (chunk: Buffer): void => {
        collected += String(chunk)
        const url = parseTunnelUrl(collected)
        if (url) settle(() => resolve(url))
      }
      // The banner goes to stderr, but watch both streams — upstream has
      // moved log destinations between releases before.
      child.stderr?.on('data', onChunk)
      child.stdout?.on('data', onChunk)
      child.once('error', err => settle(() => reject(err)))
      child.once('exit', code =>
        settle(() =>
          reject(
            new Error(
              `cloudflared exited (code ${code}) before printing a tunnel URL. ` +
                `Output:\n${collected.slice(-500)}`,
            ),
          ),
        ),
      )
    })
  }
}
