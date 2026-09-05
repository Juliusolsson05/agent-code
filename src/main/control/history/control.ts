import { z } from 'zod'
import { defineCapability, historyEventSchema, type ControlHistory } from '@control-sdk'

export function historyCapabilities(history: ControlHistory) {
  return [
    defineCapability({
      id: 'history.read', title: 'Inspect one control call', execution: 'main', effect: 'read',
      description: 'Return every durable event and payload reference for a call, including retries and unresolved outcomes. Retrieve each payload with history.payloadRead.',
      input: z.object({ callId: z.string().min(1).describe('operation.callId from a tool result, or callId from history.list.') }).strict(),
      output: z.object({ callId: z.string(), events: z.array(historyEventSchema),
        relatedCalls: z.array(z.string()), state: z.enum(['recorded', 'outcome_unknown', 'not_found']) }),
      handler: async ({ callId }) => {
        const all = await history.events()
        const events = all.filter(event => event.callId === callId)
        return { callId, events, relatedCalls: [...new Set(all.filter(event => event.reusedCallId === callId).map(event => event.callId))],
          state: events.some(event => event.kind === 'result') ? 'recorded' as const : events.length ? 'outcome_unknown' as const : 'not_found' as const }
      },
    }),
    defineCapability({
      id: 'history.list', title: 'List control history', execution: 'main', effect: 'read',
      description: 'Read durable invocation events. Carry snapshot through paging so reading history does not chase its own new records.',
      input: z.object({ after: z.number().int().nonnegative().default(0).describe('Exclusive event sequence boundary; use nextAfter from the previous page.'), snapshot: z.number().int().nonnegative().optional().describe('Keep the first page’s snapshot unchanged to finish a finite history read while new calls are recorded.'),
        limit: z.number().int().min(1).max(200).default(50).describe('Maximum events per page; call history is never silently truncated.'), callId: z.string().optional().describe('Optional exact call ID to filter events.') }).strict(),
      output: z.object({ events: z.array(historyEventSchema), snapshot: z.number().int(), nextAfter: z.number().int().nullable(), complete: z.boolean() }),
      handler: async ({ after, snapshot, limit, callId }, context) => {
        const events = await history.events()
        // The current read already has a durable intent. Freeze immediately
        // before it so an unbounded "read everything" loop can actually finish.
        const ownStart = events.find(event => event.callId === context.requestId)?.sequence ?? events.length + 1
        const head = Math.min(snapshot ?? ownStart - 1, ownStart - 1)
        const candidates = events.filter(event => event.sequence > after && event.sequence <= head && (!callId || event.callId === callId))
        const page = candidates.slice(0, limit)
        return { events: page, snapshot: head, nextAfter: candidates.length > page.length ? page.at(-1)!.sequence : null,
          complete: candidates.length <= page.length }
      },
    }),
    defineCapability({
      id: 'history.payloadRead', title: 'Read complete history payload', execution: 'main', effect: 'read',
      description: 'Read exact recorded JSON, including full prompts/results, with lossless UTF-8 byte continuations. No silent clipping.',
      input: z.object({ payloadId: z.string().regex(/^[a-f0-9]{64}$/).describe('Payload digest from a history event; not the call ID.'), offset: z.number().int().nonnegative().default(0).describe('UTF-8 byte offset. Start at zero and continue with nextOffset; do not use character counts.'),
        limit: z.number().int().min(4).max(262144).default(16384).describe('Maximum UTF-8 bytes per payload page. Character boundaries are preserved; follow nextOffset for the complete JSON.') }).strict(),
      output: z.object({ text: z.string(), offset: z.number(), nextOffset: z.number().nullable(), totalBytes: z.number(), sha256: z.string() }),
      handler: ({ payloadId, offset, limit }) => history.chunk(payloadId, offset, limit),
    }),
  ]
}
