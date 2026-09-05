import { z } from 'zod'
import { ControlError, defineCapability, controlOwnerSchema, controlResultSchema, type ControlHistory, type ControlOwner, type ControlContext } from '@control-sdk'

const startedSchema = z.object({ step: z.literal('task.started'), owner: controlOwnerSchema })
const finishedSchema = z.object({ step: z.literal('task.finished'), result: controlResultSchema })
const callId = z.string().min(1).describe('Original operation.callId returned when the lifecycle action was accepted.')

// The journal is the only task store. A renderer may disappear after accepting
// work, so a renderer-local Promise map is not an authoritative status service.
// Start/finish are application-only adapters; the external operator only reads
// their projection. No application transaction is implemented in this module.
export function taskHistoryCapabilities(history: ControlHistory, ownerAvailable: (owner: ControlOwner) => boolean) {
  let writes: Promise<unknown> = Promise.resolve()
  const mutate = <T>(run: () => Promise<T>): Promise<T> => {
    const next = writes.then(run)
    writes = next.catch(() => undefined)
    return next
  }
  const task = async (id: string) => {
    const events = (await history.events()).filter(event => event.callId === id)
    const origin = events.find(event => event.kind === 'received')
    const dispatched = events.find(event => event.kind === 'dispatched')
    const routed = dispatched?.payload ? z.object({ owner: controlOwnerSchema }).safeParse(await history.payload(dispatched.payload)) : null
    let start: z.infer<typeof startedSchema> | undefined
    let finish: z.infer<typeof finishedSchema> | undefined
    for (const event of events) {
      if (event.kind !== 'step' || !event.payload) continue
      const payload = await history.payload(event.payload)
      const started = startedSchema.safeParse(payload)
      if (started.success) start = started.data
      const finished = finishedSchema.safeParse(payload)
      if (finished.success) finish = finished.data
    }
    return { origin, start, finish, routedOwner: routed?.success ? routed.data.owner : null }
  }
  const owns = (owner: ControlOwner, context: ControlContext) => {
    const reporter = owner.kind === 'window' ? owner.windowId : `control-main:${owner.generation}`
    if (context.caller.kind !== 'application' || context.caller.id !== reporter || !ownerAvailable(owner)) {
      throw new ControlError('stale_owner', 'Task reporting requires its registered host generation')
    }
  }
  return [
    defineCapability({
      id: 'operations.start', title: 'Record lifecycle task admission', visibility: 'application', execution: 'main', effect: 'mutation',
      description: 'Application-only durable admission before beginning a long feature operation. External callers use the feature tool.',
      input: z.object({ callId, owner: controlOwnerSchema }).strict(), output: z.object({ callId: z.string(), recorded: z.literal(true) }),
      handler: (input, context) => mutate(async () => {
        owns(input.owner, context)
        const current = await task(input.callId)
        if (!current.origin || current.start) throw new ControlError('unavailable', 'Task requires one existing original call and cannot be started twice')
        if (JSON.stringify(current.routedOwner) !== JSON.stringify(input.owner)) throw new ControlError('stale_owner', 'Task owner differs from the original dispatched operation')
        // Recheck after journal IO: a reload while waiting for disk must not
        // grant the retired renderer a new transaction's admission.
        owns(input.owner, context)
        await history.append({ callId: input.callId, instanceId: current.origin.instanceId, capabilityId: current.origin.capabilityId,
          kind: 'step', at: new Date().toISOString(), caller: `application:${context.caller.id}` }, { step: 'task.started', owner: input.owner })
        return { callId: input.callId, recorded: true as const }
      }),
    }),
    defineCapability({
      id: 'operations.finish', title: 'Record lifecycle task result', visibility: 'application', execution: 'main', effect: 'mutation',
      description: 'Application-only final task evidence; records the exact domain result under the original call ID.',
      input: z.object({ callId, result: controlResultSchema }).strict(), output: z.object({ callId: z.string(), recorded: z.literal(true) }),
      handler: (input, context) => mutate(async () => {
        const current = await task(input.callId)
        if (!current.origin || !current.start || current.finish) throw new ControlError('unavailable', 'Task is absent or already finished')
        owns(current.start.owner, context)
        await history.append({ callId: input.callId, instanceId: current.origin.instanceId, capabilityId: current.origin.capabilityId,
          kind: 'step', at: new Date().toISOString(), caller: `application:${context.caller.id}` }, { step: 'task.finished', result: input.result })
        return { callId: input.callId, recorded: true as const }
      }),
    }),
    defineCapability({
      id: 'operations.read', title: 'Read a long operation result', execution: 'main', effect: 'read',
      description: 'Inspect a lifecycle operation accepted earlier by callId. Returns pending while its original main/window host is available, completed/failed with the recorded domain result, or outcome_unknown after lost ownership or an uncertain failure. Persists across app restarts. Use history.read for complete steps and payloads; never resubmit an unknown operation merely because its host disappeared.',
      input: z.object({ callId }).strict(), output: z.object({ callId: z.string(), capabilityId: z.string().nullable(), owner: controlOwnerSchema.nullable(),
        status: z.enum(['not_found', 'pending', 'completed', 'failed', 'outcome_unknown']), result: controlResultSchema.nullable() }),
      handler: async ({ callId }) => {
        const { origin, start, finish } = await task(callId)
        const result = finish?.result ?? null
        const status: 'not_found' | 'pending' | 'completed' | 'failed' | 'outcome_unknown' = !start ? 'not_found' : result ? (result.ok ? 'completed' : result.error.outcome === 'unknown' ? 'outcome_unknown' : 'failed')
          : ownerAvailable(start.owner) ? 'pending' : 'outcome_unknown'
        return { callId, capabilityId: origin?.capabilityId ?? null, owner: start?.owner ?? null, status, result }
      },
    }),
  ]
}
