import { z } from 'zod'

export const historyEventSchema = z.object({
  sequence: z.number().int().positive(), at: z.string(), instanceId: z.string(), callId: z.string(),
  kind: z.enum(['received', 'dispatched', 'result', 'duplicate', 'step', 'transport']),
  capabilityId: z.string(), caller: z.string(), requestKey: z.string().optional(),
  payload: z.string().optional(), reusedCallId: z.string().optional(),
}).strict()
export type HistoryEvent = z.infer<typeof historyEventSchema>
export type HistoryWrite = Omit<HistoryEvent, 'sequence'>

// Storage is an injected port, never a Node import in the SDK. An append only
// resolves after both its payload and index are durable. Implementations must
// reject writes after a damaged journal rather than manufacture a fresh past.
export interface ControlHistory {
  append(event: HistoryWrite, payload?: unknown): Promise<HistoryEvent>
  events(): Promise<HistoryEvent[]>
  payload(id: string): Promise<unknown>
  chunk(id: string, offset: number, limit: number): Promise<{
    text: string; offset: number; nextOffset: number | null; totalBytes: number; sha256: string
  }>
}
