import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { ControlError, controlOwnerSchema, controlResultSchema, defineCapability,
  type ControlCaller, type ControlRequest, type ControlResult } from '@control-sdk'

const targetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('agent'), sessionId: z.string().min(1), owner: controlOwnerSchema.optional() }).strict(),
  z.object({ kind: z.literal('operation'), callId: z.string().min(1) }).strict(),
])
const snapshotSchema = z.object({ status: z.unknown(), sessionRunId: z.string().nullable().optional(), providerSessionId: z.string().nullable().optional() })
const waitId = z.string().min(1).max(100)
const resultSchema = z.object({ waitId: z.string(), status: z.enum(['changed', 'attention', 'settled', 'timeout', 'cancelled', 'cursor_expired', 'unavailable']), cursor: z.string().nullable(), snapshot: controlResultSchema.nullable() })
type WaitResult = z.infer<typeof resultSchema>
type Invoke = (request: ControlRequest, caller: ControlCaller) => Promise<ControlResult>

// This adapter observes domain-owned status; it does not invent a second event
// stream or infer successful work from an idle provider. Cursors deliberately
// exclude read timestamps/receipt IDs and bind to the caller, target, owner
// generation and backend identity. A reload is a boundary, not a false delta.
export function createWaitControl(invoke: Invoke) {
  const cursors = new Map<string, { scope: string; identity: string; hash: string; expires: number }>()
  const pending = new Map<string, () => void>()
  let disposed = false
  const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
  const callerKey = (caller: ControlCaller, id: string) => JSON.stringify([caller.kind, caller.id, id])
  const capabilities = [
    defineCapability({ id: 'observations.wait', title: 'Wait for agent status or a lifecycle operation', execution: 'main', effect: 'read',
      description: 'Wait at most 10 seconds for one exact agent status or operations.read result. Agent targets accept an explicit window owner inside target; ambiguous ownership fails. until=change compares status against after, or the first observation when omitted. attention means visible condition keys or process exit (operations: failed/outcome_unknown). settled means observed input-ready idle with no queued prompts or conditions, or a terminal lifecycle result; it does NOT prove a prompt completed successfully. Use agents.read delta cursors for output text. Returns timeout/cancelled/unavailable explicitly, plus the last snapshot and a fresh status cursor. Cursors expire after five minutes, server restart, eviction, target/caller mismatch or backend/renderer replacement. Cancel concurrently with observations.cancelWait and the same caller-chosen waitId. Never resubmit mutations based only on a timeout.',
      input: z.object({ waitId, target: targetSchema, after: z.string().min(1).max(200).optional(), until: z.enum(['change', 'attention', 'settled']).default('change'), timeoutMs: z.number().int().min(0).max(10000).default(5000) }).strict(), output: resultSchema,
      handler: async (input, context): Promise<WaitResult> => {
        const key = callerKey(context.caller, input.waitId)
        if (disposed || pending.has(key) || pending.size >= 64) throw new ControlError('unavailable', 'Wait host unavailable, waitId already active, or 64 concurrent waits reached')
        const scope = JSON.stringify([context.caller, input.target])
        const previous = input.after ? cursors.get(input.after) : undefined
        let baseline = previous?.hash
        let identity = previous?.identity
        let last: WaitResult['snapshot'] = null
        let cursor: string | null = null
        let cancelled = false
        let timedOut = false
        let stop!: () => void
        const stopped = new Promise<null>(resolve => { stop = () => resolve(null) })
        pending.set(key, () => { cancelled = true; stop() })
        // The deadline includes a stuck renderer read, not just the polling
        // delay. Losing this race leaves only a read in flight; no mutation is
        // retried and no further polling is scheduled after this call ends.
        const timer = setTimeout(() => { timedOut = true; stop() }, input.timeoutMs)
        const finish = (status: WaitResult['status']): WaitResult => ({ waitId: input.waitId, status, snapshot: last, cursor })
        try {
          while (true) {
            const target = input.target
            const request: ControlRequest = target.kind === 'agent'
              ? { capabilityId: 'agents.read', input: { sessionId: target.sessionId, depth: 'status' }, owner: target.owner }
              : { capabilityId: 'operations.read', input: { callId: target.callId } }
            const read = await Promise.race([invoke(request, context.caller), stopped])
            if (cancelled) return finish('cancelled')
            if (timedOut || !read) return finish('timeout')
            last = controlResultSchema.parse(read)
            if (!read.ok) return finish('unavailable')
            const parsed = snapshotSchema.safeParse(read.value)
            if (!parsed.success) throw new ControlError('invalid_output', 'Status owner returned an invalid observation')
            const value = parsed.data
            const currentIdentity = hash([read.operation?.owner, value.sessionRunId, value.providerSessionId])
            const currentHash = hash(value.status)
            for (const [id, entry] of cursors) if (entry.expires < Date.now()) cursors.delete(id)
            // Keep one cursor per observation from this wait. Polls with no
            // change must not evict other callers' cursors every 250 ms.
            if (cursor) cursors.delete(cursor)
            while (cursors.size >= 128) cursors.delete(cursors.keys().next().value!)
            cursor = randomUUID()
            cursors.set(cursor, { scope, identity: currentIdentity, hash: currentHash, expires: Date.now() + 300000 })
            if ((input.after && (!previous || previous.scope !== scope || previous.expires < Date.now())) || (identity && identity !== currentIdentity)) return finish('cursor_expired')
            identity = currentIdentity
            const agent = z.object({ activity: z.string().nullable(), exited: z.boolean(), conditions: z.array(z.string()), queuedCount: z.number(), inputReady: z.boolean().nullable() }).safeParse(value.status)
            const attention = target.kind === 'agent' ? agent.success && (agent.data.exited || agent.data.conditions.length > 0) : ['failed', 'outcome_unknown'].includes(String(value.status))
            const settled = target.kind === 'agent' ? agent.success && !agent.data.exited && agent.data.inputReady === true && agent.data.activity === 'idle' && agent.data.queuedCount === 0 && agent.data.conditions.length === 0 : ['completed', 'failed', 'outcome_unknown'].includes(String(value.status))
            if (input.until === 'attention' && attention) return finish('attention')
            if (input.until === 'settled' && settled) return finish('settled')
            if (input.until === 'change' && baseline !== undefined && baseline !== currentHash) return finish('changed')
            baseline ??= currentHash
            let pause: ReturnType<typeof setTimeout> | undefined
            await Promise.race([new Promise<void>(resolve => { pause = setTimeout(resolve, 250) }), stopped])
            clearTimeout(pause)
            if (cancelled) return finish('cancelled')
            if (timedOut) return finish('timeout')
          }
        } finally { clearTimeout(timer); pending.delete(key) }
      },
    }),
    defineCapability({ id: 'observations.cancelWait', title: 'Cancel your pending status wait', execution: 'main', effect: 'mutation',
      description: 'Cancel only the active observations.wait with this waitId under your same caller identity. Returns cancelled=false if it already finished or belongs to another caller. Does not interrupt the agent or cancel a lifecycle operation.',
      input: z.object({ waitId }).strict(), output: z.object({ waitId: z.string(), cancelled: z.boolean() }),
      handler: (input, context) => { const cancel = pending.get(callerKey(context.caller, input.waitId)); cancel?.(); return { waitId: input.waitId, cancelled: Boolean(cancel) } },
    }),
  ]
  return { capabilities, dispose() { disposed = true; for (const cancel of pending.values()) cancel(); cursors.clear() } }
}
