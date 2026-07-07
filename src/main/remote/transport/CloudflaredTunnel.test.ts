import { createServer } from 'node:http'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CloudflaredTunnel, parseTunnelUrl } from './CloudflaredTunnel.js'

describe('parseTunnelUrl', () => {
  it('extracts the URL from the real banner-box stderr shape', () => {
    // Captured shape from cloudflared 2026.x quick-tunnel startup: the URL
    // arrives inside an ASCII box on stderr, wrapped in log-line noise.
    const chunk = [
      '2026-07-06T20:00:00Z INF Thank you for trying Cloudflare Tunnel. Doing so, without a Cloudflare account, is a quick way to experiment and try it out. However, be aware that these account-less Tunnels have no uptime guarantee.',
      '2026-07-06T20:00:01Z INF Requesting new quick Tunnel on trycloudflare.com...',
      '2026-07-06T20:00:02Z INF +--------------------------------------------------------------------------------------------+',
      '2026-07-06T20:00:02Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |',
      '2026-07-06T20:00:02Z INF |  https://random-words-here-1234.trycloudflare.com                                           |',
      '2026-07-06T20:00:02Z INF +--------------------------------------------------------------------------------------------+',
    ].join('\n')
    expect(parseTunnelUrl(chunk)).toBe('https://random-words-here-1234.trycloudflare.com')
  })

  it('returns null when no tunnel URL is present', () => {
    expect(parseTunnelUrl('2026-07-06T20:00:00Z INF Starting metrics server')).toBeNull()
    expect(parseTunnelUrl('visit https://developers.cloudflare.com for docs')).toBeNull()
  })
})

describe('CloudflaredTunnel with a fake binary', () => {
  let dir: string
  let tunnel: CloudflaredTunnel | null = null

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cf-tunnel-'))
  })

  afterEach(async () => {
    await tunnel?.stop()
    tunnel = null
    await rm(dir, { recursive: true, force: true })
  })

  /** A stand-in cloudflared: prints the quick-tunnel banner to stderr (like
   *  the real binary) and then sleeps as the live tunnel process would. */
  async function writeFakeBinary(opts: { emitUrl: boolean }): Promise<string> {
    const path = join(dir, 'fake-cloudflared')
    const banner = opts.emitUrl
      ? 'echo "2026-01-01T00:00:00Z INF |  https://fake-abcd.trycloudflare.com  |" >&2'
      : 'echo "2026-01-01T00:00:00Z ERR failed to request quick tunnel" >&2'
    await writeFile(path, `#!/bin/sh\n${banner}\nsleep 60\n`, 'utf8')
    await chmod(path, 0o755)
    return path
  }

  it('starts, parses the public URL, and kills the child on stop', async () => {
    const binary = await writeFakeBinary({ emitUrl: true })
    tunnel = new CloudflaredTunnel({ binaryPath: binary })
    const server = createServer()
    const { url } = await tunnel.start(server)
    expect(url).toBe('https://fake-abcd.trycloudflare.com')
    // Loopback-bound: the tunnel is the ONLY way in from outside.
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('no bind')
    expect(server.listening).toBe(true)

    await tunnel.stop()
    expect(server.listening).toBe(false)
  })

  it('fails with a clear error when the binary never prints a URL', async () => {
    const binary = await writeFakeBinary({ emitUrl: false })
    tunnel = new CloudflaredTunnel({ binaryPath: binary, urlTimeoutMs: 500 })
    const server = createServer()
    await expect(tunnel.start(server)).rejects.toThrow(/tunnel URL/)
    // Failure must not leak a listening server or a live child.
    expect(server.listening).toBe(false)
  })

  it('fails immediately when the binary path is missing', async () => {
    tunnel = new CloudflaredTunnel({ binaryPath: join(dir, 'nope') })
    const server = createServer()
    await expect(tunnel.start(server)).rejects.toThrow()
    expect(server.listening).toBe(false)
  })
})
