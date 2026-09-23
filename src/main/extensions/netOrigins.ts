import { isPrivateIpLiteral } from './netPolicy.js'
import { assertFetchRequestShape, boundedFetchResult, buildRequestHeaders, transportFailure, type NetFetchRequest, type NetFetchResult } from './netFetch.js'

// The net.origins capability (#1150): a brokered HTTPS fetch to one of the
// EXACT public origins the manifest declared in `networkOrigins` and the user
// saw in the consent dialog.
//
// WHY A SEPARATE FILE FROM netFetch.ts: the private-address path has its own
// target policy (literal private IPs, host-owned loopback ports). The two
// paths share everything that is NOT about the target — the request-shape
// rules (assertFetchRequestShape), credential-safe headers and errors, and the
// bounded response tail with its redirect refusal — while the TARGET rules are
// deliberately independent, so a change that relaxes one cannot silently relax
// the other.
//
// WHY THE ORIGIN LIST COMES FROM THE CALLER (capabilityService) AND NOT FROM
// THE REQUEST: the request is written by extension code; the list is read from
// the ledger row whose bundle hash just verified — i.e. from what the user
// approved. An extension cannot add a destination at runtime.

// Longer than the private route's 10 s: a public API crosses the internet
// (and TTS-style endpoints render before answering); a LAN peer should answer
// fast. The SDK documents both values (ExtensionNetApi JSDoc); change together.
const NET_ORIGINS_TIMEOUT_MS = 15_000

export type NetFetchRoute = 'net.connect' | 'net.origins'

/** Which capability a net.fetch target needs. Pure routing — the actual policy
 *  (private literal rules, declared-origin match) is enforced again by the
 *  function that performs the request. `null` means no brokered path exists. */
export function netFetchRoute(rawUrl: string, declaredOrigins: readonly string[]): NetFetchRoute | null {
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

/** The declared-origin TARGET rules (the request-shape rules are shared; see
 *  assertFetchRequestShape). Throws author-actionable errors that never include
 *  a header value or the body (they may carry an API key). */
export function assertDeclaredOriginTarget(rawUrl: string, declaredOrigins: readonly string[]): URL {
  let url: URL
  try { url = new URL(rawUrl) } catch { throw new Error('net.fetch requires an absolute https URL.') }
  if (url.protocol !== 'https:') throw new Error('net.fetch to a declared origin requires https.')
  // userinfo would be sent as Basic auth to the declared host; it is never
  // part of an origin, so a URL carrying it is not "that origin" as consented.
  if (url.username || url.password) throw new Error('net.fetch URLs must not contain credentials.')
  if (!declaredOrigins.includes(url.origin)) throw new Error(undeclaredTargetMessage(rawUrl, declaredOrigins))
  return url
}

/** Perform one declared-origin fetch. `perform` is injectable for tests;
 *  production uses the global fetch (undici in main). Nothing here logs:
 *  these requests typically carry the extension's API key in a header. */
export async function netOriginsFetch(
  request: NetFetchRequest,
  declaredOrigins: readonly string[],
  perform: typeof fetch = fetch,
): Promise<NetFetchResult> {
  const url = assertDeclaredOriginTarget(request.url, declaredOrigins)
  assertFetchRequestShape(request)
  // Shared with the private route so both give the same credential-safe
  // refusal for a mis-pasted key (see buildRequestHeaders).
  const headers = buildRequestHeaders(request.headers)
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
      // TLS PINNING NOTE: deliberately NO dispatcher/agent override. HTTPS-only
      // is the DNS-rebinding defence (a declared name re-pointed at a LAN
      // device fails because the device has no certificate for that name), and
      // that holds ONLY while default certificate validation is on. Never add
      // a dispatcher, `rejectUnauthorized: false` or NODE_TLS_REJECT_UNAUTHORIZED
      // handling here; a tripwire test in netOrigins.test.ts fails if the
      // built init gains any such key.
    })
  } catch (error) {
    // Network/abort/redirect failures: fixed copy, same helper as the private
    // route — the renderer shows this text.
    throw transportFailure(error, url.origin)
  }
  // A 3xx that surfaced as a response is refused inside the shared tail, with
  // the same message as a thrown redirect, on both routes.
  return boundedFetchResult(response, request.responseType, url.origin)
}
