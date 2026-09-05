import { z } from 'zod'

export const transcriptPageInput = z.object({
  provider: z.enum(['claude', 'codex', 'opencode']), cwd: z.string().min(1), providerSessionId: z.string().min(1),
  cursor: z.string().optional(), maxRecords: z.number().int().min(1).max(500).default(120),
}).strict()
export const transcriptPageOutput = z.object({
  entries: z.array(z.record(z.string(), z.json())), olderCursor: z.string().nullable(),
  sourceIdentity: z.string(), source: z.enum(['provider-file', 'provider-export']),
})
