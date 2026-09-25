import { z } from 'zod'
import { isExtensionJson, type ExtensionJson } from './extensionJson.js'

// The wire protocol between the host's ExtensionServiceHost and a service
// process (Electron utilityProcess). This is the ONE place both sides agree on;
// the SDK's `defineService` helper speaks it, but a service may also speak it
// directly — the host validates every message with these schemas and never
// trusts the process to be our own bootstrap.
//
// Design notes:
// - utilityProcess postMessage is structured clone, not JSON. We still bound
//   payloads with isExtensionJson so a hostile service cannot balloon main's
//   memory through the port, matching every other extension transport.
// - Every host→service request and the shutdown carry a correlation id; a
//   retired generation's late `result` is dropped by generation check in the
//   host, never delivered as a new instance's answer.

const port = z.number().int().min(1).max(65535)
const endpointName = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/)
const correlationId = z.string().min(1).max(96)
const methodName = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/)

const jsonPayload = z.custom<ExtensionJson>(isExtensionJson, 'Expected bounded JSON (4096 values, depth 32, 128 Ki characters)')

/** Service → host. A plain union (not discriminated): `result` appears twice
 *  (ok and error shapes), which a discriminated union cannot express — the same
 *  reason runtimeEventSchema is a union. */
export const serviceToHostMessageSchema = z.union([
  // Sent exactly once when the service finished initializing. Endpoints are the
  // loopback listeners it opened itself; the host re-verifies loopback-ness at
  // every use — a service reporting another host's port gets those endpoints
  // ignored (policy enforced where it is consumed).
  z.object({
    kind: z.literal('ready'),
    endpoints: z.array(z.object({ name: endpointName, port })).max(8).optional(),
  }).strict(),
  z.object({ kind: z.literal('result'), id: correlationId, ok: z.literal(true), value: jsonPayload.optional() }).strict(),
  z.object({ kind: z.literal('result'), id: correlationId, ok: z.literal(false), error: z.string().max(2000) }).strict(),
  // Acknowledged shutdown: the service saw the stop and finished cleanup.
  z.object({ kind: z.literal('stopped'), id: correlationId }).strict(),
  // Best-effort diagnostics; host logs them, never surfaces them as host UI.
  z.object({ kind: z.literal('log'), line: z.string().max(2000) }).strict(),
])
export type ServiceToHostMessage = z.infer<typeof serviceToHostMessageSchema>

/** Host → service. */
export type HostToServiceMessage =
  | { kind: 'request'; id: string; name: string; params?: ExtensionJson }
  | { kind: 'shutdown'; id: string }
