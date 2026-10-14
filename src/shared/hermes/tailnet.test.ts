import { describe, expect, it } from 'vitest'

import { tailnetKindOfHost, tailnetKindOfUrl } from './tailnet'

// Literals by necessity: the ranges are Tailscale's published constants
// (tailnet.ts header). Each boundary is chosen to fail on an off-by-one.
describe('tailnet address recognition (#1498)', () => {
  it('takes exactly 100.64.0.0/10', () => {
    expect(tailnetKindOfHost('100.63.255.255')).toBeNull()
    expect(tailnetKindOfHost('100.64.0.0')).toBe('ipv4')
    expect(tailnetKindOfHost('100.127.255.255')).toBe('ipv4')
    expect(tailnetKindOfHost('100.128.0.0')).toBeNull()
    expect(tailnetKindOfHost('2.25.114.153')).toBeNull()
  })

  it('takes MagicDNS names only on a label boundary', () => {
    expect(tailnetKindOfHost('srv1921318.tail1234.ts.net')).toBe('magicdns')
    expect(tailnetKindOfHost('srv.tail1234.ts.net.')).toBe('magicdns')
    expect(tailnetKindOfHost('evilts.net')).toBeNull()
    expect(tailnetKindOfHost('ts.net.evil.com')).toBeNull()
    expect(tailnetKindOfHost('hermes-agent-pjlj.srv1921318.hstgr.cloud')).toBeNull()
  })

  it('takes the Tailscale IPv6 prefix with or without brackets and padding', () => {
    expect(tailnetKindOfHost('fd7a:115c:a1e0::1')).toBe('ipv6')
    expect(tailnetKindOfHost('[fd7a:115c:a1e0:ab12::1]')).toBe('ipv6')
    expect(tailnetKindOfHost('fd7a:115c:a1e1::1')).toBeNull()
  })

  it('reads URLs and the scheme-less host:port users paste', () => {
    expect(tailnetKindOfUrl('http://100.101.102.103:4860')).toBe('ipv4')
    expect(tailnetKindOfUrl('100.101.102.103:4860')).toBe('ipv4')
    expect(tailnetKindOfUrl('https://hermes.tail1234.ts.net/hermes')).toBe('magicdns')
    expect(tailnetKindOfUrl('http://[fd7a:115c:a1e0::5]:4860')).toBe('ipv6')
    expect(tailnetKindOfUrl('https://hermes-agent-pjlj.srv1921318.hstgr.cloud')).toBeNull()
    expect(tailnetKindOfUrl('')).toBeNull()
  })
})
