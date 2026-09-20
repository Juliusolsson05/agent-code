import { z } from 'zod'

export const agentReadInput = z.object({
  sessionId: z.string().min(1).describe('Stable agent sessionId from agents.search or agents.list; not a project, pane position or provider-native transcript ID.'), depth: z.enum(['status', 'conversation', 'activity', 'full']).default('conversation').describe('status: readiness only, no transcript IO. conversation: user prompts and all visible assistant text. activity: add summarized tools. full: add complete available selected activity payloads.'),
  range: z.enum(['session', 'current_exchange', 'latest', 'delta']).default('session').describe('session: current history window plus older pages. current_exchange: latest accepted prompt and subsequent output in this window. latest: recent message tail. delta: changes since a completed read; requires since.'),
  cursor: z.string().optional().describe('Continue frozen messages with nextCursor. Keep sessionId and depth; do not combine with since or older.'),
  since: z.string().optional().describe('deltaCursor from a fully paged read; requires range=delta. Messages are upserts by ID, with deletedMessageIds for transient removals.'),
  older: z.string().optional().describe('olderCursor from a fully paged read. Retrieves the preceding history window without waking the agent; repeat this cursor to retry that same page.'),
  afterMessageId: z.string().optional().describe('On a fresh read, return messages after this exact ID within the selected window. Fails if absent; cannot combine with a continuation.'),
  maxMessages: z.number().int().min(1).max(200).default(50).describe('Maximum message fragments per page; for latest, also selects the number of recent messages.'),
  maxChars: z.number().int().min(256).max(262144).default(24000).describe('Text budget per page, in UTF-16 code units. Long messages continue losslessly; surrogate pairs remain intact.'),
}).strict()
export const conversationMessageSchema = z.object({
  id: z.string(), role: z.enum(['user', 'assistant', 'activity']), text: z.string(), kind: z.string(),
  source: z.string(), partial: z.boolean(), timestamp: z.string().optional(), phase: z.string().optional(),
  attachments: z.array(z.object({ id: z.string(), kind: z.string(), mimeType: z.string().optional() })).optional(),
  offset: z.number().int(), totalChars: z.number().int(), nextOffset: z.number().int().nullable(),
})
/**
 * An agent's readiness, exactly as `agents.read` emits it.
 *
 * WHY this is named and exported rather than inlined below (#875): the wait
 * adapter parsed it with a hand-written COPY, and the two disagreed on the one
 * field both of its predicates turn on — `exited` is the exit CODE or null,
 * and the copy said `z.boolean()`. Every parse failed, so `until: 'settled'`
 * and `until: 'attention'` could never be true and always ran to their
 * timeout, whatever the agent was doing. A consumer that re-declares a
 * producer's shape is a drift waiting to happen; there is one declaration now
 * and consumers import it.
 *
 * `exited` is the code, so "has it exited" is `exited !== null`: a clean exit
 * is 0, which is falsy.
 */
export const agentStatusSchema = z.object({
  // WHY closed enums and not `z.string()` (#1086 review, finding 5): the
  // producer's three fields are closed unions (`ProcessStatus`,
  // `SessionStatus`, `TranscriptStatus`), and declaring them as bare strings
  // let the CONSUMER'S FIXTURE keep a value the producer cannot emit —
  // `process: 'running'`, which is not a `ProcessStatus` — even after the
  // fixture was routed through this schema to stop exactly that. A closed
  // enum also makes the published MCP JSON Schema say what the values are,
  // rather than "string".
  process: z.enum(['idle', 'spawning', 'started', 'failed', 'exited']),
  activity: z.enum(['idle', 'running', 'exited']),
  transcript: z.enum(['idle', 'loading', 'ready', 'error', 'disconnected']),
  inputReady: z.boolean(),
  // The exit CODE or null, never a boolean. A union with `z.boolean()` would
  // re-admit the exact historical mis-shape this schema exists to reject.
  exited: z.number().nullable(),
  conditions: z.array(z.string()), queuedCount: z.number(), draftPresent: z.boolean(),
})
export type AgentStatus = z.infer<typeof agentStatusSchema>

export const agentReadOutput = z.object({
  sessionId: z.string(), provider: z.string(), providerSessionId: z.string().nullable(), sessionRunId: z.string().nullable(),
  depth: z.string(), range: z.string(), observedAt: z.number(),
  status: agentStatusSchema,
  availability: z.enum(['available', 'live_only', 'not_created', 'unavailable', 'native_terminal']),
  reason: z.string().optional(), messages: z.array(conversationMessageSchema), deletedMessageIds: z.array(z.string()),
  nextCursor: z.string().nullable().describe('Finish this frozen message window before starting older pages or a delta.'), deltaCursor: z.string().nullable().describe('Available after all message pages; use as since for range=delta.'), olderCursor: z.string().nullable().describe('Available after all message pages; use as older to walk backward through history.'),
  hasMore: z.boolean(), snapshotId: z.string().nullable(),
  ordering: z.literal('chronological within each window; olderCursor requests the preceding history window'),
})
export type AgentReadInput = z.infer<typeof agentReadInput>
export type AgentReadOutput = z.infer<typeof agentReadOutput>
export type ReadDepth = AgentReadInput['depth']
