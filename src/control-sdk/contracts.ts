import { z } from 'zod'

// WHY owners include a generation, rather than only the app's stable window
// ID: that window survives a renderer reload. A reply from its previous JS
// world must never be accepted as evidence about the replacement workspace.
export const controlOwnerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('main'), generation: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('window'), windowId: z.string().min(1), generation: z.string().min(1) }).strict(),
])
export type ControlOwner = z.infer<typeof controlOwnerSchema>

export type ControlCaller = Readonly<{
  kind: 'external' | 'application'
  id: string
}>

export type ControlContext = Readonly<{
  requestId: string
  caller: ControlCaller
  owner: ControlOwner
}>

export type ControlFailureCode =
  | 'unavailable' | 'ambiguous_owner' | 'stale_owner'
  | 'invalid_input' | 'invalid_output' | 'failed'
  | 'stale_cursor' | 'invalid_cursor'
  | 'history_unavailable' | 'idempotency_conflict' | 'interrupted'

export class ControlError extends Error {
  constructor(readonly code: ControlFailureCode, message: string, readonly outcome: 'not_started' | 'unknown' = 'not_started') {
    super(message)
    this.name = 'ControlError'
  }
}

export const controlOperationSchema = z.object({
  callId: z.string(), instanceId: z.string(), owner: controlOwnerSchema.optional(),
  status: z.enum(['completed', 'ui_opened', 'pending', 'blocked', 'outcome_unknown']),
  reusedCallId: z.string().optional(), historyWarning: z.string().optional(),
}).strict()
export type ControlResult<T = unknown> = (
  | { ok: true; value: T }
  | { ok: false; error: { code: ControlFailureCode; message: string; outcome: 'not_started' | 'unknown' } }
) & { operation?: z.infer<typeof controlOperationSchema> }

export type CapabilityDescriptor = Readonly<{
  id: string
  title: string
  description: string
  execution: 'main' | 'window'
  effect: 'read' | 'ui' | 'mutation'
  completion: 'completed' | 'accepted'
  inputSchema: Record<string, unknown>
  outputSchema: Record<string, unknown>
}>

export type CapabilityListing = { descriptor: CapabilityDescriptor; owner: ControlOwner }

// These are the only shapes allowed across the control IPC bridge. Schemas are
// data; executable closures stay in their owning process. A renderer cannot
// register a main-owned capability or choose another window's identity.
export const capabilityDescriptorSchema = z.object({
  id: z.string().regex(/^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+$/),
  title: z.string().min(1), description: z.string().min(1),
  execution: z.enum(['main', 'window']), effect: z.enum(['read', 'ui', 'mutation']),
  completion: z.enum(['completed', 'accepted']),
  inputSchema: z.record(z.string(), z.json()), outputSchema: z.record(z.string(), z.json()),
}).strict()

export const controlRegistrationSchema = z.object({
  generation: z.string().min(1),
  capabilities: z.array(capabilityDescriptorSchema).max(4096),
}).strict()
export type ControlRegistration = z.infer<typeof controlRegistrationSchema>

export const controlRequestSchema = z.object({
  capabilityId: z.string().min(1), input: z.json(), owner: controlOwnerSchema.optional(),
  requestKey: z.string().min(1).max(256).optional(),
}).strict()

export const controlResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: z.json(), operation: controlOperationSchema.optional() }).strict(),
  z.object({ ok: z.literal(false), error: z.object({
    code: z.enum(['unavailable', 'ambiguous_owner', 'stale_owner', 'invalid_input', 'invalid_output', 'failed', 'stale_cursor', 'invalid_cursor', 'history_unavailable', 'idempotency_conflict', 'interrupted']),
    message: z.string(), outcome: z.enum(['not_started', 'unknown']),
  }).strict(), operation: controlOperationSchema.optional() }).strict(),
])

export type RendererControlRequest = {
  request: ControlRequest
  context: ControlContext
}

export const rendererControlResponseSchema = z.object({
  requestId: z.string().min(1), generation: z.string().min(1), result: controlResultSchema,
}).strict()
export type RendererControlResponse = z.infer<typeof rendererControlResponseSchema>

export type ControlRequest = Readonly<{
  capabilityId: string
  input: unknown
  owner?: ControlOwner
  requestKey?: string
}>

// A transport owns identity; none of these fields are accepted from tool input.
// In particular an external caller cannot label itself as an application user
// by adding a caller property to its JSON arguments.
export interface ControlTransport {
  invoke(request: ControlRequest): Promise<ControlResult>
}

export function controlFailure(
  code: ControlFailureCode,
  message: string,
  outcome: 'not_started' | 'unknown' = 'not_started',
): ControlResult<never> {
  return { ok: false, error: { code, message, outcome } }
}
