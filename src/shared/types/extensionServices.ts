import { z } from 'zod'
import { isExtensionJson, type ExtensionJson } from './extensionJson.js'

// Service calls cross either the view's postMessage broker or the runtime's
// dedicated preload. Keep their untrusted argument grammar in one shared schema;
// a method that exists on only one transport would make the public v2 API depend
// on whether the author happened to call it from a view or from the background.
const sessionId = z.string().min(1).max(128)
const projectPath = z.string().min(1).max(1024)
const fileVersion = z.string().min(1).max(512)

export const extensionFileReadRequestSchema = z.object({
  method: z.literal('fs.readText'),
  sessionId,
  path: projectPath,
}).strict()

export const extensionFileWriteRequestSchema = z.object({
  method: z.literal('fs.writeText'),
  sessionId,
  path: projectPath,
  // null is deliberately distinct from omission: it means "create only".
  // Replacing an existing file always requires a version returned by readText,
  // so an extension cannot unknowingly overwrite an editor or agent mutation.
  expectedVersion: fileVersion.nullable(),
  text: z.string().max(64 * 1024),
}).strict()

export const extensionNotificationRequestSchema = z.object({
  method: z.literal('notifications.show'),
  // Background notifications are intentionally short status messages. A hard
  // transport bound keeps a broken extension from turning one toast into an
  // unbounded application overlay or IPC payload.
  message: z.string().trim().min(1).max(200),
}).strict()

// Service call params/results and the process protocol share the same bounded
// JSON definition as every other extension transport — one limit, everywhere.
const jsonPayload = z.custom<ExtensionJson>(isExtensionJson, 'Expected bounded JSON (4096 values, depth 32, 128 Ki characters)')

// --- Services (capability: service.run) --------------------------------------
// Lifecycle + RPC for bundled native service processes. Both the view frame and
// the background runtime use these exact shapes; capabilityService is the single
// broker, so the two transports cannot develop different lifecycle rules.
const serviceId = z.string().min(1).max(96)
const serviceMethod = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/)

export const serviceStartRequestSchema = z.object({
  method: z.literal('service.start'),
  serviceId,
}).strict()

export const serviceStopRequestSchema = z.object({
  method: z.literal('service.stop'),
  serviceId,
}).strict()

export const serviceStatusRequestSchema = z.object({
  method: z.literal('service.status'),
  serviceId,
}).strict()

export const serviceInvokeRequestSchema = z.object({
  method: z.literal('service.invoke'),
  serviceId,
  // `name`, not a second `method`: runtime.request already uses `name` for the
  // author-chosen handler identifier, and reusing the word keeps the two RPC
  // surfaces reading the same way for SDK consumers.
  name: serviceMethod,
  params: jsonPayload.optional(),
}).strict()

export const serviceExposeRequestSchema = z.object({
  method: z.literal('service.expose'),
  serviceId,
  // lan:false closes an existing exposure without revoking anything else.
  lan: z.boolean(),
}).strict()

// --- Outbound fetch (capabilities: net.connect / net.origins) ----------------
// `method` is the transport discriminator, so the HTTP verb gets its own field.
// The URL/target policy lives in netFetch.ts / netOrigins.ts and is enforced
// again in main before any socket opens — the schema bounds shape, not
// reachability.

/** The plain HTTP verbs an extension may send anywhere the host carries its
 *  request: both net.fetch routes AND the service.transport proxy. No CONNECT
 *  (a tunnel the host could not inspect), no TRACE (echoes request headers,
 *  i.e. credentials, back into the response) and no upgrade. ONE list because
 *  this zod enum, main's defence-in-depth check (netFetch.ts
 *  assertFetchRequestShape) and the proxy used to spell it three times; a verb
 *  added to one would silently be refused, or admitted, by another. It lives
 *  here, not in main, because this schema is shared code and cannot import
 *  main. */
export const NET_FETCH_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH'] as const
export type NetFetchMethod = (typeof NET_FETCH_METHODS)[number]
/** Request headers per net.fetch. Shared with main's re-check for the same
 *  reason as NET_FETCH_METHODS. */
export const MAX_NET_FETCH_HEADERS = 16
/** Request body cap. Main checks UTF-8 BYTES (what goes on the wire); the
 *  schema below can only bound UTF-16 length, which is never larger than the
 *  byte count for the same string, so the schema is the looser, cheaper gate
 *  and main's byte check is the one that binds. */
export const MAX_NET_FETCH_BODY_BYTES = 64 * 1024

const netHeader = z.object({ name: z.string().min(1).max(64), value: z.string().max(1024) }).strict()

export const netFetchRequestSchema = z.object({
  method: z.literal('net.fetch'),
  url: z.string().max(2048),
  httpMethod: z.enum(NET_FETCH_METHODS).optional(),
  headers: z.array(netHeader).max(MAX_NET_FETCH_HEADERS).optional(),
  body: z.string().max(MAX_NET_FETCH_BODY_BYTES).optional(),
  // 'base64' exists for binary bodies (audio, images). The transports are
  // JSON; decoding arbitrary bytes as UTF-8 replaces invalid sequences with
  // U+FFFD, which silently corrupts the payload instead of failing.
  responseType: z.enum(['text', 'base64']).optional(),
}).strict()

// --- Secrets (Tier 0, per-extension, OS-encrypted) ---------------------------
// The namespace is the extension id the authenticated transport fixed, never
// a field here. Values are bounded so one extension cannot turn the keychain-
// backed store into bulk storage; api.storage exists for data.
//
// Exported because main's secret store (secrets.ts) enforces the same grammar
// a second time right before it touches the filesystem. It used to hand-copy
// both, so a widened schema could admit keys the store then refused (or the
// reverse) with two different error texts.
export const SECRET_KEY_PATTERN = /^[a-zA-Z0-9._-]{1,64}$/
export const MAX_SECRET_VALUE_LENGTH = 4096
const secretKey = z.string().regex(SECRET_KEY_PATTERN, 'secret keys are 1-64 characters of [a-zA-Z0-9._-]')

export const secretsGetRequestSchema = z.object({ method: z.literal('secrets.get'), key: secretKey }).strict()
export const secretsSetRequestSchema = z.object({
  method: z.literal('secrets.set'),
  key: secretKey,
  value: z.string().min(1).max(MAX_SECRET_VALUE_LENGTH),
}).strict()
export const secretsDeleteRequestSchema = z.object({ method: z.literal('secrets.delete'), key: secretKey }).strict()

export const extensionServiceRequestSchema = z.discriminatedUnion('method', [
  extensionFileReadRequestSchema,
  extensionFileWriteRequestSchema,
  extensionNotificationRequestSchema,
  serviceStartRequestSchema,
  serviceStopRequestSchema,
  serviceStatusRequestSchema,
  serviceInvokeRequestSchema,
  serviceExposeRequestSchema,
  netFetchRequestSchema,
  secretsGetRequestSchema,
  secretsSetRequestSchema,
  secretsDeleteRequestSchema,
])

export type ExtensionServiceRequest = z.infer<typeof extensionServiceRequestSchema>

/** A bounded UTF-8 file read from the project owned by `sessionId`. */
export type ExtensionTextFile = {
  /** The session target is echoed so concurrent reads remain attributable. */
  sessionId: string
  /** Normalized project-relative path. Absolute project locations never leak here. */
  path: string
  text: string
  size: number
  mtimeMs: number
  /** Opaque compare-and-swap token accepted by writeText. */
  version: string
}

/** Metadata for a safely published UTF-8 project file. */
export type ExtensionTextFileWrite = {
  sessionId: string
  path: string
  size: number
  mtimeMs: number
  /** The next opaque token required to replace this version. */
  version: string
}

/** Result of net.fetch. `bodyEncoding` echoes what the host actually did, so a
 *  caller that asked for base64 can tell a host that honoured it from an older
 *  one that ignored the field and returned text. */
export type ExtensionNetFetchResult = {
  status: number
  contentType: string
  body: string
  bodyEncoding: 'text' | 'base64'
}

export type ExtensionServiceResult = ExtensionTextFile | ExtensionTextFileWrite | ExtensionServiceHandle | ExtensionServiceStatus | ExtensionServiceExposure | ExtensionNetFetchResult | string | null | void

/** Runtime status of one declared service, as returned by start/status. */
export type ExtensionServiceHandle = {
  state: 'running'
  serviceId: string
  /** OS pid for diagnostics; never used as authority. */
  pid: number
  /** Loopback endpoints the service reported at ready(). Empty when it serves
   *  only RPC. Ports come from the service; the host re-verifies loopback before
   *  any proxy/ LAN exposure uses them (later capabilities). */
  endpoints: Array<{ name: string; port: number }>
}

export type ExtensionServiceStatus =
  | { state: 'stopped'; serviceId: string }
  | ExtensionServiceHandle

/** Result of service.expose: the port the HOST bound on the machine's
 *  interfaces (OS-chosen). The service's own loopback port stays private. */
export type ExtensionServiceExposure =
  | { serviceId: string; lan: false }
  | { serviceId: string; lan: true; port: number }

export type ExtensionNotification = {
  extensionId: string
  message: string
}

export type ExtensionFilesApi = {
  /**
   * Read a text file from a live session's project. Requires `fs.read`.
   *
   * A background runtime has no focused pane, so the target is always explicit.
   * The host derives the project root from its main-owned session record; callers
   * cannot substitute an arbitrary absolute root.
   */
  readText(options: { sessionId: string; path: string }): Promise<ExtensionTextFile>

  /**
   * Atomically create or replace a bounded text file. Requires `fs.write`.
   * Use expectedVersion: null for create-only, or pass readText().version when
   * replacing a file. A stale token rejects without overwriting newer bytes.
   */
  writeText(options: {
    sessionId: string
    path: string
    text: string
    expectedVersion: string | null
  }): Promise<ExtensionTextFileWrite>
}

export type ExtensionNotificationsApi = {
  /** Show a short app-wide status toast. Requires `notifications.show`. */
  show(message: string): Promise<void>
}
