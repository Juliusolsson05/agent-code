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

export type ControlResult<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; error: { code: ControlFailureCode; message: string; outcome: 'not_started' | 'unknown' } }

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

export type ControlRequest = Readonly<{
  capabilityId: string
  input: unknown
  owner?: ControlOwner
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
