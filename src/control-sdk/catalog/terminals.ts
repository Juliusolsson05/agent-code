import { z } from 'zod'

export const terminalReadInput = z.object({
  sessionId: z.string().min(1).describe('Stable terminal or agent sessionId from app.observe. Agent conversations are usually clearer through agents.read.'),
  range: z.enum(['tail', 'retained']).default('tail').describe('Tail returns recent bytes; retained pages the entire currently retained replay, not unlimited shell history.'),
  cursor: z.string().optional().describe('Opaque nextCursor from this read, preserving session and range. Frozen pages expire after five minutes or a backend replacement.'),
  maxChars: z.number().int().min(256).max(262144).default(24000).describe('Maximum UTF-16 code units per page; Unicode character boundaries are preserved.'),
}).strict()
export const terminalReadOutput = z.object({ sessionId: z.string(), sessionRunId: z.string(), source: z.literal('retained-pty-replay'),
  raw: z.string(), offset: z.number(), totalChars: z.number(), capChars: z.number(), hasEarlierRetainedText: z.boolean(),
  nextCursor: z.string().nullable(), revision: z.string() })
export const terminalInput = z.object({ sessionId: z.string().min(1).describe('Exact terminal or raw agent session ID.'),
  sessionRunId: z.string().min(1).describe('Current backend lifetime from terminals.read. A restarted backend rejects this write.'),
  data: z.string().min(1).max(65536).describe('Exact raw input, including any intended carriage return or escape sequence. Nothing is appended. For an ordinary agent prompt use agents.prompt instead.') }).strict()
export const terminalInputOutput = z.object({ sessionId: z.string(), sessionRunId: z.string(), delivered: z.literal(true) })
