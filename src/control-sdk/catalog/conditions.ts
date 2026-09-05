import { z } from 'zod'

export const conditionTargetInput = z.object({ sessionId: z.string().min(1).describe('Stable sessionId from agents.search/list.') }).strict()
export const conditionReadOutput = z.object({
  sessionId: z.string(), sessionRunId: z.string().nullable(), revision: z.string(),
  conditions: z.array(z.object({ kind: z.string(), state: z.json(),
    actions: z.array(z.object({ id: z.string(), label: z.string(), kind: z.enum(['pty', 'custom']) })) })),
})
export const conditionReplyInput = conditionTargetInput.extend({
  revision: z.string().describe('Exact revision from agents.conditionsRead; changed conditions or a replaced backend require a new read.'),
  kind: z.string().describe('Condition kind from agents.conditionsRead.'),
  actionId: z.string().describe('Exact advertised action ID for this condition; never invent a key sequence or payload.'),
})
// The window contributes its actual metadata to the backing operation. That
// ownership assertion must be checked in main with the backend lifetime and
// latest condition, immediately before dispatch rather than across two IPCs.
export const conditionBackendIdentity = z.object({ cwd: z.string(), provider: z.string() })
export const conditionReplyOutput = z.object({ sessionId: z.string(), sessionRunId: z.string(), actionId: z.string(), accepted: z.literal(true) })
