import { z } from 'zod'
import type { CapabilityListing, ControlRequest, ControlResult } from './contracts'

// This is a transport port, not an application service locator. External
// adapters receive this already scoped caller from app composition. They may
// enumerate descriptors and submit typed requests but cannot reach UI stores,
// provider sessions, filesystem paths or the registry's private dispatch API.
export interface ControlOperatorPort {
  catalog(): CapabilityListing[]
  invoke(request: ControlRequest): Promise<ControlResult>
  recordTransport(event: { id: string; method: string; direction: 'request' | 'response' | 'failure'; payload: unknown }): Promise<void>
}

export const operatorRoutingSchema = z.object({
  windowId: z.string().min(1).optional().describe('Stable ID from ac_app_windows. Selects this window even when another is focused.'),
  generation: z.string().min(1).optional().describe('Optional renderer lifetime from ac_app_windows; rejects a reload instead of following it.'),
  requestKey: z.string().min(1).max(256).optional().describe('Reuse the same key for retries of the same intention; a changed payload with this key is rejected.'),
}).strict()

export const externalConnectionStatusSchema = z.object({
  enabled: z.boolean(), running: z.boolean(), port: z.number().int(), url: z.string().nullable(),
  serverName: z.literal('agent-code-control'), error: z.string().nullable(),
})
export type ExternalConnectionStatus = z.infer<typeof externalConnectionStatusSchema>
