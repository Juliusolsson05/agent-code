import { z } from 'zod'
import { agentReadInput, controlOwnerSchema, controlResultSchema, defineCapability,
  type ControlCaller, type ControlRequest, type ControlResult } from '@control-sdk'

const owner = controlOwnerSchema.optional().describe('Exact owner from agents.search. Omit only when the session has one unambiguous owner.')
const key = z.string().min(1).max(80).describe('Stable item intention key, unique within this batch. Preserve it across partial retries; never derive it from item position.')
const result = z.object({ itemKey: z.string(), sessionId: z.string(), result: controlResultSchema })
const output = z.object({ items: z.array(result), succeeded: z.number(), failed: z.number() })
type Invoke = (request: ControlRequest, caller: ControlCaller) => Promise<ControlResult>

// Batches compose the existing executor, including its caller, durable intent,
// ownership and uncertainty rules. Calling a renderer's application bridge from
// here would silently upgrade an external caller and bypass child idempotency.
// Sequential children bound provider admission pressure and make partial work
// observable; a failed child never cancels or rewinds already delivered prompts.
export function batchControlCapabilities(invoke: Invoke) {
  const unique = <T extends { itemKey: string }>(items: T[]) => new Set(items.map(item => item.itemKey)).size === items.length
  return [
    defineCapability({ id: 'agents.batchRead', title: 'Read several agents with independent cursors', execution: 'main', effect: 'read',
      description: 'Read up to 20 exact agents across windows using the ordinary agents.read contract. Returns a separate success/error and continuation cursor set per item; one unavailable agent does not hide the others. Defaults to user prompts and assistant prose. Each page is capped at 8192 characters per agent; use the individual nextCursor/olderCursor/deltaCursor with that same agent. Does not wake agents.',
      input: z.object({ items: z.array(z.object({ itemKey: key, owner, read: agentReadInput.extend({ maxChars: z.number().int().min(256).max(8192).default(4000), maxMessages: z.number().int().min(1).max(50).default(20) }) }).strict()).min(1).max(20).refine(unique, 'Item keys must be unique') }).strict(), output,
      handler: async (input, context) => {
        const items: z.infer<typeof result>[] = []
        for (const item of input.items) items.push({ itemKey: item.itemKey, sessionId: item.read.sessionId,
          result: controlResultSchema.parse(await invoke({ capabilityId: 'agents.read', input: item.read, owner: item.owner }, context.caller)) })
        return { items, succeeded: items.filter(item => item.result.ok).length, failed: items.filter(item => !item.result.ok).length }
      },
    }),
    defineCapability({ id: 'agents.batchPrompt', title: 'Deliver a batch with per-agent receipts', execution: 'main', effect: 'mutation',
      description: 'Deliver up to 20 independent prompts through agents.prompt, including its provider checks and app-draft preservation. Returns each child receipt/error; success counts acceptance, not finished work. Every child has a durable request key derived from batchKey + itemKey under your original caller identity. To inspect/retry a partial batch, retain those keys and the exact item arguments; never generate new keys for uncertain deliveries. Changing arguments under an existing key conflicts. The batch is not atomic and continues after a child fails.',
      input: z.object({ batchKey: z.string().min(1).max(80).describe('Stable identity of this batch intention. Retain it with each itemKey across partial retry requests.'),
        items: z.array(z.object({ itemKey: key, owner, sessionId: z.string().min(1), prompt: z.string().min(1).max(32000) }).strict()).min(1).max(20).refine(unique, 'Item keys must be unique') }).strict(), output,
      handler: async (input, context) => {
        const items: z.infer<typeof result>[] = []
        for (const item of input.items) items.push({ itemKey: item.itemKey, sessionId: item.sessionId,
          result: controlResultSchema.parse(await invoke({ capabilityId: 'agents.prompt', input: { sessionId: item.sessionId, prompt: item.prompt }, owner: item.owner,
            // Length-delimited keys prevent ("a:b", "c") colliding with
            // ("a", "b:c"). These are intention IDs, never secret credentials.
            requestKey: `batch:${input.batchKey.length}:${input.batchKey}:${item.itemKey}` }, context.caller)) })
        return { items, succeeded: items.filter(item => item.result.ok).length, failed: items.filter(item => !item.result.ok).length }
      },
    }),
  ]
}
