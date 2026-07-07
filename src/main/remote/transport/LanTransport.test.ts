import { createServer } from 'node:http'
import { describe, expect, it } from 'vitest'

import { LanTransport, pickLanIpv4 } from './LanTransport.js'

describe('pickLanIpv4', () => {
  it('prefers a non-internal IPv4 address', () => {
    const ip = pickLanIpv4({
      lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
      en0: [
        { family: 'IPv6', address: 'fe80::1', internal: false },
        { family: 'IPv4', address: '192.168.1.42', internal: false },
      ],
    } as never)
    expect(ip).toBe('192.168.1.42')
  })

  it('prefers a physical interface over an earlier-enumerated VPN tunnel', () => {
    // networkInterfaces() order is arbitrary; a utun (VPN) address baked
    // into the pairing QR is unreachable from a phone on the same Wi-Fi.
    const ip = pickLanIpv4({
      utun3: [{ family: 'IPv4', address: '10.8.0.2', internal: false }],
      en0: [{ family: 'IPv4', address: '192.168.1.42', internal: false }],
    } as never)
    expect(ip).toBe('192.168.1.42')
  })

  it('avoids virtual interfaces even without a physical-looking name', () => {
    const ip = pickLanIpv4({
      utun3: [{ family: 'IPv4', address: '10.8.0.2', internal: false }],
      weird0: [{ family: 'IPv4', address: '172.20.0.9', internal: false }],
    } as never)
    expect(ip).toBe('172.20.0.9')
  })

  it('falls back to loopback when no external interface exists', () => {
    const ip = pickLanIpv4({
      lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    } as never)
    expect(ip).toBe('127.0.0.1')
  })
})

describe('LanTransport', () => {
  it('binds the server and reports a URL with the bound port', async () => {
    const server = createServer()
    const transport = new LanTransport({ port: 0 })
    const { url } = await transport.start(server)
    const address = server.address()
    expect(address && typeof address === 'object').toBe(true)
    if (!address || typeof address === 'string') throw new Error('no bind')
    expect(url).toMatch(new RegExp(`^http://\\d+\\.\\d+\\.\\d+\\.\\d+:${address.port}$`))
    await transport.stop()
    expect(server.listening).toBe(false)
  })
})
