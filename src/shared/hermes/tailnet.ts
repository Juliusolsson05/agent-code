// Is a Hermes URL a Tailscale (tailnet) address? (#1498, Tailscale phase 1)
//
// WHY the app cares: the owner wants Hermes reachable only over their tailnet
// (no public HTTPS route). When such a connection fails, the cause is almost
// always "Tailscale is not connected on this Mac" or "this device is not
// allowed by the tailnet ACL", not "hermes serve is down". Saying so needs to
// know the address is a tailnet one. Shared because main words the error
// (service.ts describeError) and the renderer shows a Tailscale tag; both
// must agree on the rule.
//
// The ranges are Tailscale's own published constants:
//  - MagicDNS names end in `.ts.net` (https://tailscale.com/kb/1081/magicdns);
//  - IPv4 addresses come from the CGNAT block 100.64.0.0/10;
//  - IPv6 addresses from the ULA prefix fd7a:115c:a1e0::/48
//    (https://tailscale.com/kb/1033/ip-and-dns-addresses).

export type TailnetKind = 'magicdns' | 'ipv4' | 'ipv6'

export function tailnetKindOfHost(rawHost: string): TailnetKind | null {
  const host = rawHost.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (!host) return null
  // A label boundary, so `evilts.net` and `ts.net.evil.com` are not tailnet.
  if (host.endsWith('.ts.net')) return 'magicdns'
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    // 100.64.0.0/10 = 100.64.0.0 – 100.127.255.255.
    return a === 100 && b >= 64 && b <= 127 ? 'ipv4' : null
  }
  // fd7a:115c:a1e0::/48 — the first three hextets, in any zero-padding.
  const hextets = host.split(':')
  if (hextets.length >= 3 && host.includes(':')) {
    const norm = hextets.slice(0, 3).map((h) => h.replace(/^0+(?=.)/, ''))
    if (norm[0] === 'fd7a' && norm[1] === '115c' && norm[2] === 'a1e0') return 'ipv6'
  }
  return null
}

/** Same rule for a whole URL (or a scheme-less `host:port`, as users paste Tailscale IPs). */
export function tailnetKindOfUrl(rawUrl: string): TailnetKind | null {
  const value = rawUrl.trim()
  if (!value) return null
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`)
    return tailnetKindOfHost(url.hostname)
  } catch {
    return null
  }
}
