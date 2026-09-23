import { isPrivateIpLiteral } from './netPolicy.js'

// The net.connect capability: a brokered, bounded, outbound HTTP fetch for
// runtimes and views. The sandbox stays sealed — the CHILD never dials; it asks
// main, main checks the target against the address policy, performs the fetch,
// and hands back a bounded answer.
//
// v1 POLICY (deliberate, not a shortfall): literal private/loopback IPs only.
// "Join the table at 192.168.1.42:5192" is the shape this exists for. DNS names
// are refused because a hostname is not an address — it resolves wherever, and
// the consent dialog plus logs must be able to state exactly who was talked to.
// Public literals are refused pending an explicit future policy decision.

export const MAX_NET_FETCH_BODY_BYTES = 64 * 1024
export const MAX_NET_FETCH_RESPONSE_BYTES = 256 * 1024
const NET_FETCH_TIMEOUT_MS = 10_000
const MAX_HEADERS = 16

export type NetFetchRequest = {
  url: string
  httpMethod?: string
  headers?: Array<{ name: string; value: string }>
  body?: string
  /** 'base64' returns the raw bytes base64-encoded (binary bodies); default text. */
  responseType?: 'text' | 'base64'
}

export type NetFetchResult = {
  status: number
  contentType: string
  body: string
  bodyEncoding: 'text' | 'base64'
}

const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH'])

/** Structural validation beyond the zod transport schema: everything here is
 *  what the policy needs before a socket is opened. Throws user-actionable
 *  errors — these strings surface in the extension's own console. */
export function assertFetchableTarget(rawUrl: string, request: NetFetchRequest): URL {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error('net.fetch requires an absolute http(s) URL.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('net.fetch supports http and https URLs only.')
  }
  // A literal IP host only. URL normalizes IPv6 to bracketed form; strip it for
  // the policy check. Port is allowed (any service port); userinfo is refused
  // by the literal requirement anyway.
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (!isPrivateIpLiteral(host)) {
    throw new Error(
      `net.fetch is limited to private local-network addresses in this release; "${url.hostname}" is not one. ` +
        'Use a literal address like http://192.168.1.20:5192/ on a trusted network.',
    )
  }
  const verb = request.httpMethod ?? 'GET'
  if (!ALLOWED_METHODS.has(verb)) {
    throw new Error('net.fetch does not support upgrades or tunnels.')
  }
  if (request.body !== undefined && Buffer.byteLength(request.body, 'utf8') > MAX_NET_FETCH_BODY_BYTES) {
    throw new Error(`net.fetch bodies are limited to ${MAX_NET_FETCH_BODY_BYTES} bytes.`)
  }
  if ((request.headers?.length ?? 0) > MAX_HEADERS) {
    throw new Error(`net.fetch accepts at most ${MAX_HEADERS} headers.`)
  }
  return url
}

/** Perform one brokered fetch. `perform` is injectable for tests; production
 *  uses the global fetch (Electron main's Chromium net stack). */
export async function netFetch(request: NetFetchRequest, perform: typeof fetch = fetch): Promise<NetFetchResult> {
  const url = assertFetchableTarget(request.url, request)
  const headers = new Headers()
  for (const header of request.headers ?? []) {
    // Header names are validated by Headers itself; duplicates append per fetch
    // semantics. Nothing here can set forbidden headers like host.
    headers.set(header.name.toLowerCase(), header.value)
  }
  const response = await perform(url.toString(), {
    method: request.httpMethod ?? 'GET',
    headers,
    ...(request.body !== undefined ? { body: request.body } : {}),
    signal: AbortSignal.timeout(NET_FETCH_TIMEOUT_MS),
    // The policy above checked THIS url. Following a 3xx would let a private
    // address bounce the request (headers included) to any public host the
    // check never saw, so a redirect is an error, not a hop.
    redirect: 'error',
  })
  return boundedFetchResult(response, request.responseType)
}

/** Shared tail for both brokered fetch paths (private net.connect and declared
 *  net.origins): one byte cap and one encoding rule, so the two cannot drift. */
export async function boundedFetchResult(response: Response, responseType: 'text' | 'base64' = 'text'): Promise<NetFetchResult> {
  const contentType = response.headers.get('content-type') ?? 'application/octet-stream'
  // Hard byte cap: this crosses back into a sandboxed frame, where a 2 GiB
  // body is a memory attack, not data. A declared Content-Length over the cap
  // is refused before reading; the post-read check covers chunked bodies.
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > MAX_NET_FETCH_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {})
    throw new Error(`net.fetch responses are limited to ${MAX_NET_FETCH_RESPONSE_BYTES} bytes.`)
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.byteLength > MAX_NET_FETCH_RESPONSE_BYTES) {
    throw new Error(`net.fetch responses are limited to ${MAX_NET_FETCH_RESPONSE_BYTES} bytes.`)
  }
  return responseType === 'base64'
    ? { status: response.status, contentType, body: buffer.toString('base64'), bodyEncoding: 'base64' }
    : { status: response.status, contentType, body: buffer.toString('utf8'), bodyEncoding: 'text' }
}
