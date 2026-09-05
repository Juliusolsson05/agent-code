import {
  ControlError, controlFailure, type CapabilityListing, type ControlCaller, type ControlContext,
  type ControlRequest, type ControlResult,
} from '../contracts'
import type { ControlHistory, HistoryEvent, HistoryWrite } from '../history'
import { resolveOwner } from './target-resolution/resolveOwner'

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
  return JSON.stringify(value)
}

export function createControlExecutor(ports: {
  history: ControlHistory; instanceId: string; id(): string; now(): string
  catalog(): CapabilityListing[]
  activateOwner?(owner: CapabilityListing['owner']): Promise<void>
  ownershipEvidence?(kind: 'session' | 'project', id: string, context: Omit<ControlContext, 'owner'>): Promise<CapabilityListing['owner'][]>
  dispatch(request: ControlRequest, context: Omit<ControlContext, 'owner'>): Promise<ControlResult>
}) {
  // Only admission is serialized. Slow agents in one window cannot block
  // unrelated operations. Reserving a key durably before releasing admission
  // closes the concurrent-retry race, including retries after process restart.
  let admission: Promise<unknown> = Promise.resolve()
  const active = new Map<string, Promise<ControlResult>>()
  async function exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = admission.then(run)
    admission = next.catch(() => undefined)
    return next
  }

  return {
    async invoke(request: ControlRequest, caller: ControlCaller): Promise<ControlResult> {
      const callId = ports.id()
      const base = { callId, instanceId: ports.instanceId, capabilityId: request.capabilityId,
        caller: `${caller.kind}:${caller.id}`, requestKey: request.requestKey }
      const write = (kind: HistoryWrite['kind'], payload?: unknown, extra: Partial<HistoryWrite> = {}) =>
        ports.history.append({ ...base, at: ports.now(), kind, ...extra }, payload)
      let finish!: (result: ControlResult) => void
      const completion = new Promise<ControlResult>(resolve => { finish = resolve })
      let previous: HistoryEvent | undefined
      let signature: string
      try {
        // Compare canonical request values, avoiding hash collisions without
        // storing a second escaped copy of every potentially large prompt.
        signature = canonical({ capabilityId: request.capabilityId, input: request.input, owner: request.owner ?? null })
        await exclusive(async () => {
          const events = request.requestKey ? await ports.history.events() : []
          previous = events.find(event => event.kind === 'received' && event.caller === base.caller
            && event.requestKey === request.requestKey)
          if (!previous) {
            await write('received', { request })
            active.set(callId, completion)
          } else await write('duplicate', { request }, { reusedCallId: previous.callId })
        })
      } catch {
        // No effect is allowed without a durable intent. Do not fall back to
        // console logging: that would make mutation retries impossible to audit.
        return { ...controlFailure('history_unavailable', 'History could not record intent; operation was not dispatched'),
          operation: { callId, instanceId: ports.instanceId, status: 'blocked' } }
      }

      let result: ControlResult
      let owner: CapabilityListing['owner'] | undefined
      let completionKind: 'completed' | 'accepted' = 'completed'
      let effect = 'read'
      let dispatched = false
      try {
        if (previous) {
          const { request: original } = await ports.history.payload(previous.payload!) as { request: ControlRequest }
          const originalSignature = canonical({ capabilityId: original.capabilityId, input: original.input, owner: original.owner ?? null })
          if (originalSignature !== signature) result = controlFailure('idempotency_conflict', 'Request key already identifies different arguments')
          else {
            const running = active.get(previous.callId)
            if (running) result = await running
            else {
              const recorded = (await ports.history.events()).find(event => event.callId === previous!.callId && event.kind === 'result')
              result = recorded?.payload
                ? await ports.history.payload(recorded.payload) as ControlResult
                : controlFailure('interrupted', 'Previous call has no durable result. Inspect its history and app state; do not automatically retry.', 'unknown')
            }
          }
        } else {
          const resolved = await resolveOwner(request, ports.catalog(), ports.ownershipEvidence ? async (kind, id) => {
            await write('step', { step: 'resolve-owner', kind, id, state: 'started' })
            const owners = await ports.ownershipEvidence!(kind, id, { requestId: callId, caller })
            await write('step', { step: 'resolve-owner', kind, id, owners, state: 'completed' })
            return owners
          } : undefined)
          owner = resolved.owner
          completionKind = resolved.descriptor.completion
          effect = resolved.descriptor.effect
          await write('dispatched', { owner })
          dispatched = true
          if (effect === 'ui' && ports.activateOwner) {
            await write('step', { step: 'activate-owner', owner, state: 'started' })
            await ports.activateOwner(owner)
            await write('step', { step: 'activate-owner', owner, state: 'completed' })
          }
          result = await ports.dispatch({ ...request, owner }, { requestId: callId, caller })
        }
      } catch (error) {
        result = error instanceof ControlError
          ? controlFailure(error.code, error.message, error.outcome)
          : controlFailure(dispatched || previous ? 'failed' : 'history_unavailable',
            error instanceof Error ? error.message : 'Control execution failed', dispatched || previous ? 'unknown' : 'not_started')
      }
      result = { ...result, operation: {
        callId, instanceId: ports.instanceId, ...(owner ? { owner } : {}),
        status: previous && result.operation ? result.operation.status : result.ok
          ? completionKind === 'accepted' ? 'pending' : effect === 'ui' ? 'ui_opened' : 'completed'
          : result.error.outcome === 'unknown' ? 'outcome_unknown' : 'blocked',
        ...(previous ? { reusedCallId: previous.callId } : {}),
      } }
      try { await write('result', result) } catch {
        // The effect may be known in this process even though its final record
        // failed. Preserve that distinction and the durable intent's call ID.
        result.operation!.historyWarning = 'Result was not persisted. A retry after restart will report an unknown outcome.'
      }
      finish(result)
      // Keep admission keys in the journal, not an unbounded live promise map.
      active.delete(callId)
      return result
    },
  }
}
