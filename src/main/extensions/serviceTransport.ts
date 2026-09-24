import type { ExtensionCapability } from '@shared/types/extensions.js'
import { NET_FETCH_METHODS } from '@shared/types/extensionServices.js'
import { TRANSPORT_ATTESTATION, TRANSPORT_ATTESTATION_HEADER } from '../../../packages/agent-code-extension-api/dist/service.js'

// The service.transport proxy: the ONLY network-shaped thing a sandboxed frame
// or runtime can do. A fetch to its own origin under __service/<serviceId>/... is
// re-issued by the host main process against that service's loopback endpoint.
//
// WHY A PROXY INSTEAD OF LOOSENING CSP: the child's connect-src stays 'self'.
// The frame therefore cannot talk to ANY network endpoint — not localhost, not
// another extension's service, not the internet — only to this path, which the
// host resolves through grant + running-service state on every request. This is
// Chrome's runtime.connect shape: own-service messaging as a namespace right,
// never arbitrary network.
//
// WHY 404 AND NOT 403 FOR DENIALS: a 403 would let any installed extension probe
// which service ids exist and whether rivals' services run. A missing page says
// nothing. The caller that legitimately owns the service gets real errors (the
// service not started reads as 404 'service is not running' body copy only it
// can correlate).

export const SERVICE_TRANSPORT_PREFIX = '__service/'

/** Injectable seams so unit tests drive this without Electron or real sockets. */
export type ServiceTransportOptions = {
  hasCapability(extensionId: string, revision: string, capability: ExtensionCapability): Promise<boolean>
  /** Port of the service's first reported loopback endpoint, or null. */
  serviceEndpoint(extensionId: string, serviceId: string): number | null
  /** Default: Electron net.fetch (main-process network stack). */
  fetch?: typeof fetch
}

// The attestation header (`service` here, `lan` from the LAN listener) is
// imported from the SDK, not declared here: services read it through the same
// export, so the host and every service share one spelling of the wire
// contract. The SDK's service.ts JSDoc states the trust rules services apply.

/** Caller headers that survive the proxy. Everything else is dropped. Named
 *  apart from the LAN listener's LAN_FORWARDED_HEADERS: the two lists differ on
 *  purpose (a same-principal frame has no Origin a service could check). */
const PROXY_FORWARDED_HEADERS = ['accept', 'content-type', 'authorization'] as const

const MAX_PROXIED_BODY_BYTES = 1024 * 1024
// The same plain-verb list as net.fetch (see NET_FETCH_METHODS for why these
// and nothing else); one list so the two frame-to-network paths cannot drift.
const PROXIED_METHODS: ReadonlySet<string> = new Set(NET_FETCH_METHODS)

let config: ServiceTransportOptions | null = null

/** Wire the singleton the scheme handler uses. Called from main composition. */
export function configureServiceTransport(options: ServiceTransportOptions): void {
  config = options
}

export function clearServiceTransport(): void {
  config = null
}

async function defaultFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  // Lazy import keeps this module importable under plain Node (unit tests).
  const { net } = await import('electron')
  return net.fetch(input as string | Request, init)
}

/** Whether a bundle-relative path addresses the service transport. The scheme
 *  handler consults this; the proxy itself assumes a match and always answers. */
export function isServiceTransportPath(relativePath: string): boolean {
  return relativePath.startsWith(SERVICE_TRANSPORT_PREFIX)
}

/**
 * Serve `__service/<serviceId>/<path…>` for one extension origin. Only call
 * after isServiceTransportPath(); always returns a Response to serve.
 */
export async function proxyServiceTransportRequest(
  extensionId: string,
  revision: string,
  relativePath: string,
  request: Request,
): Promise<Response> {
  if (!config) return new Response('service transport unavailable', { status: 503 })

  const rest = relativePath.slice(SERVICE_TRANSPORT_PREFIX.length)
  const separator = rest.indexOf('/')
  // `__service/<id>` with no trailing path still addresses "/" on the service;
  // `__service/` with no id at all is just a missing page.
  const serviceId = separator === -1 ? rest : rest.slice(0, separator)
  const servicePath = separator === -1 ? '/' : rest.slice(separator)
  if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,191}$/.test(serviceId) || !servicePath.startsWith('/')) {
    return new Response('not found', { status: 404 })
  }
  if (!PROXIED_METHODS.has(request.method)) {
    // No CONNECT and no upgrades: WebSockets are explicitly unsupported in v1.
    return new Response('method not allowed', { status: 405 })
  }

  // Grant first, running-state second. A not-yet-started service under a granted
  // extension gets actionable copy; an ungranted extension learns nothing.
  if (!(await config.hasCapability(extensionId, revision, 'service.transport'))) {
    return new Response('not found', { status: 404 })
  }
  const port = config.serviceEndpoint(extensionId, serviceId)
  if (port === null) return new Response('service is not running', { status: 404 })

  // Bound the request body BEFORE forwarding. The child is sandboxed but the
  // service is a trusting local process; a runaway frame must not be able to
  // balloon main's memory through the proxy.
  let body: ReadableStream<Uint8Array> | undefined
  if (request.method !== 'GET' && request.method !== 'HEAD' && request.body) {
    const declared = Number(request.headers.get('content-length') ?? Number.NaN)
    if (Number.isFinite(declared) && declared > MAX_PROXIED_BODY_BYTES) {
      return new Response('payload too large', { status: 413 })
    }
    const reader = request.body.getReader()
    let seen = 0
    body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await reader.read()
        if (done) { controller.close(); return }
        seen += value.byteLength
        if (seen > MAX_PROXIED_BODY_BYTES) {
          // Cancel mid-stream: the service never sees a truncated request it
          // might mistake for a complete one.
          void reader.cancel('payload too large')
          controller.error(new Error('payload too large'))
          return
        }
        controller.enqueue(value)
      },
      cancel(reason) { void reader.cancel(reason) },
    })
  }

  // WHY AN ALLOW-LIST THAT NOW INCLUDES AUTHORIZATION: a bearer-token service
  // answered 401 to every authenticated route when only accept/content-type
  // passed (#1147). The token
  // is the frame's own, sent to its own service — forwarding it widens nothing.
  // Cookies and arbitrary headers still stay behind: the frame's origin is an
  // extension scheme, and nothing it could carry there means anything upstream.
  const headers = new Headers()
  for (const name of PROXY_FORWARDED_HEADERS) {
    const value = request.headers.get(name)
    if (value !== null) headers.set(name, value)
  }
  // The host's attestation, always SET here and never copied from the caller
  // (the allow-list above cannot carry it through). It tells the service
  // "this request came from your owning extension's own frame; grant and
  // endpoint checks already passed" — i.e. same-principal, so the service can
  // treat it like its own same-origin page.
  //
  // WHY A CUSTOM HEADER AND NOT A SYNTHETIC ORIGIN: the dial below goes through
  // Electron net.fetch on Chromium's network stack, where Origin is a
  // restricted request header — whether a set value survives (or Chromium adds
  // its own) is not something the source proves, and the service would then
  // 403 every POST. A custom header is delivered verbatim. It is also the
  // classic CSRF-proof signal: a browser page cannot attach it cross-origin
  // without a CORS preflight, which a service that never answers OPTIONS with
  // CORS headers refuses. Services must therefore only trust it on a loopback
  // socket and must never grant CORS — see the LAN listener, which sets
  // `lan` instead, for the downgrade half of this contract.
  headers.set(TRANSPORT_ATTESTATION_HEADER, TRANSPORT_ATTESTATION.service)

  try {
    // Loopback by construction: the endpoint came from the service host's
    // reported ports and is dialed HERE, never in the child.
    const upstream = await (config.fetch ?? defaultFetch)(`http://127.0.0.1:${port}${servicePath}${new URL(request.url).search}`, {
      method: request.method,
      headers,
      ...(body ? { body, duplex: 'half' as const } : {}),
    })
    // RESPONSE-HEADER POLICY: only content-type crosses back; the service's
    // CSP/nosniff are dropped on purpose (the LAN listener passes them — see
    // LAN_FORWARDED_RESPONSE_HEADERS there). The only consumer here is the
    // extension's own frame, the same principal as the service, and the
    // frame's host-set CSP (childFrameCsp, default-src 'none', so no nested
    // frame can render these as a document) is the policy that applies. A
    // service CSP could restrict nothing the extension cannot already do. The
    // LAN listener is different: there a third party's browser loads the
    // service's page top-level, and the service's headers are its only
    // protection.
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
        'cache-control': 'no-store',
      },
    })
  } catch {
    // The service died between the port lookup and the dial; read exactly like
    // a not-running service so callers have one retry path: start, then fetch.
    return new Response('service is not running', { status: 404 })
  }
}
