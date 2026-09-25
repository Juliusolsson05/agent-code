import { describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { get as httpGet } from 'node:http'
import type { AddressInfo } from 'node:net'

import { isPrivateIpLiteral, normalizeIpLiteral } from './netPolicy.js'
import { startServiceLanListener } from './serviceLanListener.js'

// The address policy is the boundary both network capabilities lean on; the
// table below is the contract. Literal IPs only — a hostname is never "private".

describe('netPolicy', () => {
  it.each([
    ['127.0.0.1', true], ['127.8.8.8', true],
    ['10.0.0.5', true], ['10.255.255.255', true],
    ['192.168.1.42', true],
    ['172.16.0.1', true], ['172.31.255.255', true],
    ['172.32.0.1', false], ['172.15.0.1', false],
    ['169.254.7.7', true],
    ['100.64.0.1', true], ['100.127.255.255', true], ['100.128.0.1', false],
    ['8.8.8.8', false], ['1.1.1.1', false], ['172.217.4.46', false],
    ['::1', true], ['::', true],
    ['fe80::1', true], ['fdaa::1', true], ['fc00::1', true],
    ['2606:4700::1111', false],
    ['::ffff:192.168.1.42', true], ['::ffff:8.8.8.8', false],
  ])('%s private=%s', (host, expected) => {
    expect(isPrivateIpLiteral(host)).toBe(expected)
  })

  it('hostnames are not literals and are never treated as private', () => {
    expect(isPrivateIpLiteral('localhost')).toBe(false)
    expect(isPrivateIpLiteral('router.local')).toBe(false)
    expect(normalizeIpLiteral('not-an-ip')).toBeNull()
  })
})

describe('startServiceLanListener', () => {
  it('reverse-proxies a loopback request to the target and closes cleanly', async () => {
    // A real upstream on loopback proves the proxy path end-to-end; a public
    // SOURCE address cannot be simulated from this machine, so the private-
    // source drop is covered by the policy table above plus the one-line check.
    const upstream = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(`hit ${req.url}`) })
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
    const upstreamPort = (upstream.address() as AddressInfo).port
    const listener = await startServiceLanListener(upstreamPort)
    try {
      expect(listener.port).toBeGreaterThan(0)
      const body = await new Promise<string>((resolve, reject) => {
        httpGet({ host: '127.0.0.1', port: listener.port, path: '/api/proof' }, response => {
          expect(response.statusCode).toBe(200)
          let text = ''
          response.on('data', chunk => { text += chunk })
          response.on('end', () => resolve(text))
        }).on('error', reject)
      })
      expect(body).toBe('hit /api/proof')
    } finally {
      await listener.close()
      upstream.close()
    }
  })
})
