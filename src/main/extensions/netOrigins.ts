import { isPrivateIpLiteral } from './netPolicy.js'
import { boundedFetchResult, MAX_NET_FETCH_BODY_BYTES, type NetFetchRequest, type NetFetchResult } from './netFetch.js'

// The net.origins capability (#1150): a brokered HTTPS fetch to one of the
// EXACT public origins the manifest declared in `networkOrigins` and the user
// saw in the consent dialog.
//
// WHY A SEPARATE FILE FROM netFetch.ts: the private-address path has its own
// policy table and its own open work (#1148 adds host-reserved headers and
// loopback-port guards there). The two paths share only the bounded response
// tail (boundedFetchResult) — the TARGET rules are deliberately independent,
// so a change that relaxes one cannot silently relax the other.
//
// WHY THE ORIGIN LIST COMES FROM THE CALLER (capabilityService) AND NOT FROM
// THE REQUEST: the request is written by extension code; the list is read from
// the ledger row whose bundle hash just verified — i.e. from what the user
// approved. An extension cannot add a destination at runtime.

const NET_ORIGINS_TIMEOUT_MS = 15_000
const MAX_HEADERS = 16
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH'])

/** Which capability a net.fetch target needs. Pure routing — the actual policy
 *  (private literal rules, declared-origin match) is enforced again by the
 *  function that performs the request. `null` means no brokered path exists. */
export function netFetchRoute(rawUrl: string, declaredOrigins: readonly string[]): 'net.connect' | 'net.origins' | null {
  let url: URL
  try { url = new URL(rawUrl) } catch { return null }
  if ((url.protocol === 'http:' || url.protocol === 'https:') && isPrivateIpLiteral(url.hostname.replace(/^\[|\]$/g, ''))) return 'net.connect'
  if (url.protocol === 'https:' && declaredOrigins.includes(url.origin)) return 'net.origins'
  return null
}

/** The refusal copy for a target neither path accepts. Names the declared list
 *  (authored, public manifest data) so an author sees the fix; never echoes
 *  headers or body. */
export function undeclaredTargetMessage(rawUrl: string, declaredOrigins: readonly string[]): string {
  let shown = 'that URL'
  try { shown = `"${new URL(rawUrl).origin}"` } catch { /* keep generic */ }
  return declaredOrigins.length
    ? `net.fetch can reach private local-network addresses (net.connect) or this extension's declared networkOrigins (${declaredOrigins.join(', ')}); ${shown} is neither.`
    : `net.fetch can reach private local-network addresses (net.connect) only; ${shown} is not one. ` +
      'To call a public HTTPS API, declare its exact origin in "networkOrigins" and request "net.origins".'
}

/** Validate before any socket opens. Throws author-actionable errors that never
 *  include a header value or the body (they may carry an API key). */
export function assertDeclaredOriginTarget(request: NetFetchRequest, declaredOrigins: readonly string[]): URL {
  let url: URL
  try { url = new URL(request.url) } catch { throw new Error('net.fetch requires an absolute https URL.') }
  if (url.protocol !== 'https:') throw new Error('net.fetch to a declared origin requires https.')
  // userinfo would be sent as Basic auth to the declared host; it is never
  // part of an origin, so a URL carrying it is not "that origin" as consented.
  if (url.username || url.password) throw new Error('net.fetch URLs must not contain credentials.')
  if (!declaredOrigins.includes(url.origin)) throw new Error(undeclaredTargetMessage(request.url, declaredOrigins))
  const verb = request.httpMethod ?? 'GET'
  if (!ALLOWED_METHODS.has(verb)) throw new Error('net.fetch does not support upgrades or tunnels.')
  if (request.body !== undefined && Buffer.byteLength(request.body, 'utf8') > MAX_NET_FETCH_BODY_BYTES) {
    throw new Error(`net.fetch bodies are limited to ${MAX_NET_FETCH_BODY_BYTES} bytes.`)
  }
  if ((request.headers?.length ?? 0) > MAX_HEADERS) throw new Error(`net.fetch accepts at most ${MAX_HEADERS} headers.`)
  return url
}

/** Perform one declared-origin fetch. `perform` is injectable for tests;
 *  production uses the global fetch (main's network stack). Nothing here logs:
 *  these requests typically carry the extension's API key in a header. */
export async function netOriginsFetch(
  request: NetFetchRequest,
  declaredOrigins: readonly string[],
  perform: typeof fetch = fetch,
): Promise<NetFetchResult> {
  const url = assertDeclaredOriginTarget(request, declaredOrigins)
  const headers = new Headers()
  for (const header of request.headers ?? []) {
    try {
      headers.set(header.name.toLowerCase(), header.value)
    } catch {
      // Headers throws with the offending VALUE in its message on some
      // runtimes. Replace it: an invalid header is usually a mis-pasted key.
      throw new Error(`net.fetch header "${header.name}" is not a valid HTTP header.`)
    }
  }
  let response: Response
  try {
    response = await perform(url.toString(), {
      method: request.httpMethod ?? 'GET',
      headers,
      ...(request.body !== undefined ? { body: request.body } : {}),
      signal: AbortSignal.timeout(NET_ORIGINS_TIMEOUT_MS),
      // THE declared origin is what the user approved. A 3xx to anywhere else
      // — another host, or http — would carry the same headers (the API key)
      // to a destination nobody consented to. Redirects are errors.
      redirect: 'error',
      // No ambient browser state: main's fetch has no cookie jar for these
      // requests, and this states the intent for any future runtime swap.
      credentials: 'omit',
    })
  } catch (error) {
    // Network/abort/redirect failures. Undici's messages can embed the URL but
    // never headers; still, return fixed copy — the renderer shows this text.
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
    throw new Error(timedOut
      ? `net.fetch to ${url.origin} timed out.`
      : `net.fetch to ${url.origin} failed (network error or refused redirect).`)
  }
  if (response.status >= 300 && response.status < 400) {
    // Some fetch implementations surface an opaque redirect instead of
    // throwing under redirect:'error'. Same decision either way.
    throw new Error(`net.fetch to ${url.origin} was redirected; redirects are not followed.`)
  }
  return boundedFetchResult(response, request.responseType)
}
