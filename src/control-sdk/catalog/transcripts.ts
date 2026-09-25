import { z } from 'zod'

export const transcriptPageInput = z.object({
  // Literal on purpose: the control SDK is published standalone and cannot
  // import Agent Code's provider registry. Keep in step with AGENT_PROVIDER_KINDS.
  provider: z.enum(['claude', 'codex', 'opencode', 'grok', 'pi']), cwd: z.string().min(1), providerSessionId: z.string().min(1),
  cursor: z.string().optional(), maxRecords: z.number().int().min(1).max(500).default(120),
}).strict()
export const transcriptPageOutput = z.object({
  entries: z.array(z.record(z.string(), z.json())), olderCursor: z.string().nullable(),
  sourceIdentity: z.string(), source: z.enum(['provider-file', 'provider-export', 'provider-history']),
})
