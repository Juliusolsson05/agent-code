// Address policy shared by the network capabilities (net.listen's source
// filter, net.connect's target check). LITERAL IPs only in v1 — a hostname can
// resolve anywhere, and "private" must be a property of the address shown in
// the consent dialog and the log, not of a DNS answer that changes.

/** Normalize an IP literal for classification (strips IPv6-mapped IPv4 and
 *  Node's bracket form). Returns null for anything that is not a literal. */
export function normalizeIpLiteral(host: string): string | null {
  let candidate = host.trim().toLowerCase()
  if (candidate.startsWith('[') && candidate.endsWith(']')) candidate = candidate.slice(1, -1)
  const mapped = candidate.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) candidate = mapped[1]
  // Re-check after unwrapping: the capture above only looks IPv4-shaped.
  if (!/^(\d+\.\d+\.\d+\.\d+)$/.test(candidate) && !candidate.includes(':')) return null
  return candidate
}

function ipv4Octets(literal: string): number[] | null {
  const parts = literal.split('.')
  if (parts.length !== 4) return null
  const octets = parts.map(Number)
  if (octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null
  return octets
}

/** Is this IP literal private to this machine or its local network?
 *  Loopback, RFC1918, carrier-grade NAT space, and link-local (v4+v6) count as
 *  private. Everything else — including a public address on THIS machine's
 *  interfaces — is public. */
export function isPrivateIpLiteral(host: string): boolean {
  const literal = normalizeIpLiteral(host)
  if (literal === null) return false
  const v4 = ipv4Octets(literal)
  if (v4) {
    const [a, b] = v4
    if (a === 127) return true // loopback
    if (a === 10) return true // RFC1918
    if (a === 192 && b === 168) return true // RFC1918
    if (a === 172 && b >= 16 && b <= 31) return true // RFC1918
    if (a === 169 && b === 254) return true // link-local (also 169.254 CGNAT-adjacent)
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT — treated as local
    return false
  }
  // IPv6 literals.
  if (literal === '::1' || literal === '::') return true
  if (literal.startsWith('fe80:')) return true // link-local
  if (literal.startsWith('fc') || literal.startsWith('fd')) return true // unique local fc00::/7
  return false
}
