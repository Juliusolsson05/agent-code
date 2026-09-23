// What a browser pocket may load (spec §8). Shared by the renderer's address
// bar and main's navigation guards so the two can never disagree. T3 Code had
// an allow-list in its address bar and none on the guest itself, so a page
// could navigate anywhere. Main runs this check again as the authority,
// because the renderer is not a security boundary.
export type NormalisedPocketUrl =
  | { ok: true; url: string }
  | { ok: false; reason: 'empty' | 'scheme' | 'invalid' }

const ALLOWED = new Set(['http:', 'https:'])

export function isAllowedTopLevelUrl(url: string): boolean {
  try {
    return ALLOWED.has(new URL(url).protocol)
  } catch {
    return false
  }
}

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.localhost)$/i

/** Loopback per spec §8.3: self-signed certs and "localhost links" apply only here. */
export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK.test(hostname)
}

export function isLoopbackUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return ALLOWED.has(u.protocol) && isLoopbackHost(u.hostname)
  } catch {
    return false
  }
}

export function normalisePocketUrl(input: string): NormalisedPocketUrl {
  const raw = input.trim()
  if (!raw) return { ok: false, reason: 'empty' }
  // `5173` / `:5173`: the dev-server shorthand every surveyed product accepts.
  // A bare port can only sensibly mean loopback.
  const port = /^:?(\d{2,5})$/.exec(raw)
  if (port) return Number(port[1]) <= 65535 ? { ok: true, url: `http://localhost:${port[1]}/` } : { ok: false, reason: 'invalid' }
  // `host:port` without a scheme parses as a URL whose scheme is the host
  // (`localhost:3000` → protocol "localhost:"), so recognise that shape FIRST,
  // and only treat the prefix as a real scheme otherwise. The order matters in
  // the other direction too: `javascript:1` must NOT be read as host
  // "javascript", port 1.
  const hostPort = /^([a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:]+\]):(\d{1,5})(\/.*)?$/i.exec(raw)
  if (hostPort && !/^(javascript|data|file|vbscript|blob|about|chrome|devtools)$/i.test(hostPort[1]!)) {
    return toUrl(`http://${raw}`)
  }
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(raw)
  if (scheme) {
    if (!ALLOWED.has(`${scheme[1]!.toLowerCase()}:`)) return { ok: false, reason: 'scheme' }
    return toUrl(raw)
  }
  // Scheme-less host (`example.com/path`): dev URLs are http far more often.
  return toUrl(`http://${raw}`)
}

function toUrl(value: string): NormalisedPocketUrl {
  try {
    const url = new URL(value)
    if (!ALLOWED.has(url.protocol) || !url.hostname) return { ok: false, reason: 'invalid' }
    return { ok: true, url: url.toString() }
  } catch {
    return { ok: false, reason: 'invalid' }
  }
}
