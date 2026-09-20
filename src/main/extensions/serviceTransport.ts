import type { ExtensionCapability } from '@shared/types/extensions.js'

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

const MAX_PROXIED_BODY_BYTES = 1024 * 1024
const PROXIED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH'])

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

  const headers = new Headers()
  for (const name of ['accept', 'content-type']) {
    const value = request.headers.get(name)
    if (value !== null) headers.set(name, value)
  }

  try {
    // Loopback by construction: the endpoint came from the service host's
    // reported ports and is dialed HERE, never in the child.
    const upstream = await (config.fetch ?? defaultFetch)(`http://127.0.0.1:${port}${servicePath}${new URL(request.url).search}`, {
      method: request.method,
      headers,
      ...(body ? { body, duplex: 'half' as const } : {}),
    })
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
