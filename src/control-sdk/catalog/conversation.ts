import { z } from 'zod'

export const agentReadInput = z.object({
  sessionId: z.string().min(1), depth: z.enum(['status', 'conversation', 'activity', 'full']).default('conversation'),
  range: z.enum(['session', 'current_exchange', 'latest', 'delta']).default('session'),
  cursor: z.string().optional(), since: z.string().optional(), older: z.string().optional(),
  afterMessageId: z.string().optional(),
  maxMessages: z.number().int().min(1).max(200).default(50),
  maxChars: z.number().int().min(256).max(262144).default(24000),
}).strict()
export const conversationMessageSchema = z.object({
  id: z.string(), role: z.enum(['user', 'assistant', 'activity']), text: z.string(), kind: z.string(),
  source: z.string(), partial: z.boolean(), timestamp: z.string().optional(), phase: z.string().optional(),
  attachments: z.array(z.object({ id: z.string(), kind: z.string(), mimeType: z.string().optional() })).optional(),
  offset: z.number().int(), totalChars: z.number().int(), nextOffset: z.number().int().nullable(),
})
export const agentReadOutput = z.object({
  sessionId: z.string(), provider: z.string(), providerSessionId: z.string().nullable(), sessionRunId: z.string().nullable(),
  depth: z.string(), range: z.string(), observedAt: z.number(),
  status: z.object({ process: z.string(), activity: z.string(), transcript: z.string(), inputReady: z.boolean(),
    exited: z.number().nullable(), conditions: z.array(z.string()), queuedCount: z.number(), draftPresent: z.boolean() }),
  availability: z.enum(['available', 'live_only', 'not_created', 'unavailable', 'native_terminal']),
  reason: z.string().optional(), messages: z.array(conversationMessageSchema), deletedMessageIds: z.array(z.string()),
  nextCursor: z.string().nullable(), deltaCursor: z.string().nullable(), olderCursor: z.string().nullable(),
  hasMore: z.boolean(), snapshotId: z.string().nullable(),
  ordering: z.literal('chronological within each window; olderCursor requests the preceding history window'),
})
export type AgentReadInput = z.infer<typeof agentReadInput>
export type AgentReadOutput = z.infer<typeof agentReadOutput>
export type ReadDepth = AgentReadInput['depth']
