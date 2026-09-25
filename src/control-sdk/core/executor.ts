import {
  ControlError, controlFailure, type CapabilityDescriptor, type CapabilityListing,
  type ControlCaller, type ControlContext, type ControlRequest, type ControlResult,
} from '../contracts'
import type { ControlHistory, HistoryEvent, HistoryWrite } from '../history'
import { resolveOwner } from './target-resolution/resolveOwner'

/**
 * Capabilities that RECORD an effect rather than causing one. See the gate in
 * `invoke` for why they are exempt from it.
 */
const RECEIPT_CAPABILITY_IDS = new Set(['operations.start', 'operations.finish'])

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

  // ── COMMITTED SHUTDOWN (#943) ──
  // Two facts, deliberately separate. `closed` stops NEW effects entering;
  // `inFlight` is how many admitted operations have not finished writing their
  // result yet. Disposing the host used to retire IPC handlers and stop there,
  // which released the exit and the state-process lock while an admitted
  // mutation was still running and its durable result still queued.
  //
  // `inFlight` is counted from the TOP of `invoke`, before the serialized
  // received-intent append, NOT from the `active` map. `active` is populated
  // only AFTER that append succeeds, so draining it alone would miss every
  // operation still inside admission — which is exactly where the slow,
  // serialized part is.
  let closed = false
  let inFlight = 0
  /**
   * Operations that were ACCEPTED rather than completed (#1074 review, 2).
   *
   * `startControlTask` journals `operations.start`, returns
   * `{callId, accepted:true}` immediately and runs the real work in a floating
   * async body. So the executor call that admitted it finishes at once,
   * `inFlight` drops to zero, and a drain built on `inFlight` alone reports
   * settled while the mutation is still running — every `agents.prompt`,
   * `agents.close`, `agents.rewind`, `commands.run`, `workflows.start` and the
   * rest of the accepted class. Review drove it: the journal ended with
   * `task.started` and no `task.finished`, which is verbatim the state this
   * drain exists to prevent.
   *
   * The executor already computes `status: 'pending'` for exactly these, and
   * the task's own completion travels back through it as `operations.finish`
   * carrying the same callId, so it can account for them without knowing
   * anything about what a task DOES.
   */
  const acceptedTasks = new Set<string>()
  const idleWaiters: Array<() => void> = []
  function releaseIfIdle(): void {
    if (inFlight > 0 || acceptedTasks.size > 0) return
    for (const waiter of idleWaiters.splice(0)) waiter()
  }

  /** The declared effect of a capability, without resolving an owner.
   *
   *  Owner resolution writes history and can consult ownership evidence, so it
   *  cannot run before the admission decision. The catalog entry is enough to
   *  answer the only question the gate asks: would admitting this CHANGE
   *  anything? An id that is not in the catalog is treated as effectful, so an
   *  unknown capability is refused during shutdown rather than waved through. */
  function declaredEffect(capabilityId: string): CapabilityDescriptor['effect'] {
    return ports.catalog().find(listing => listing.descriptor.id === capabilityId)?.descriptor.effect ?? 'mutation'
  }
  async function exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = admission.then(run)
    admission = next.catch(() => undefined)
    return next
  }

  return {
    /** Stop admitting new effects. Reads still answer: inspecting the app
     *  during its own shutdown changes nothing, and refusing would blind the
     *  very tooling used to diagnose a stuck quit. Idempotent. */
    closeAdmission(): void {
      closed = true
    },

    /**
     * What is still outstanding right now: admitted calls that have not
     * returned, plus accepted tasks whose bodies have not reported back.
     *
     * Synchronous on purpose. The DEADLINE lives in the host, not here — this
     * package is provider- and platform-neutral and has no timer in its lib
     * (review caught `setTimeout` failing the neutral type-check), so the
     * executor exposes the fact and the host decides how long to wait for it.
     */
    outstanding(): { drained: boolean; operations: number; tasks: number } {
      return {
        drained: inFlight === 0 && acceptedTasks.size === 0,
        operations: inFlight,
        tasks: acceptedTasks.size,
      }
    },

    /**
     * Resolves once every ADMITTED operation has finished — including its
     * durable result write, and including the body of an ACCEPTED task, which
     * outlives the call that started it.
     *
     * Unbounded by design; see `outstanding` for why the bound is the host's.
     */
    async settled(): Promise<void> {
      if (inFlight === 0 && acceptedTasks.size === 0) return
      await new Promise<void>(resolve => { idleWaiters.push(resolve) })
    },

    async invoke(
      request: ControlRequest,
      caller: ControlCaller,
      options: {
        /** This call is part of an operation that was already admitted — a
         *  batch member, a wait's inner invoke, or the main process recording
         *  its own operation receipt. Nested calls are never refused: the
         *  parent is mid-flight and half-finishing it is worse than finishing
         *  it. Explicit rather than inferred from `inFlight > 0`, which cannot
         *  tell a batch member from a fresh external request arriving at the
         *  same moment. */
        nested?: boolean
      } = {},
    ): Promise<ControlResult> {
      // ── RECEIPTS ARE NEVER REFUSED (#1074 review, 3) ──
      // `operations.start` and `operations.finish` do not CAUSE an effect,
      // they RECORD one. The renderer reports its own lifecycle through
      // `control:invoke`, which carries no `nested` flag, so closing admission
      // refused the receipt for an effect that had already happened — with
      // `outcome: 'not_started'`, which is the opposite of the truth. They are
      // also how an accepted task's body reports back, so refusing them would
      // make the drain below wait for something that can never arrive.
      const receipt = RECEIPT_CAPABILITY_IDS.has(request.capabilityId)
      if (closed && !receipt && options.nested !== true && declaredEffect(request.capabilityId) !== 'read') {
        return {
          ...controlFailure(
            'unavailable',
            'Agent Code is shutting down and is no longer admitting control operations.',
            'not_started',
          ),
          operation: { callId: ports.id(), instanceId: ports.instanceId, status: 'blocked' },
        }
      }
      inFlight += 1
      try {
        return await invokeAdmitted(request, caller)
      } finally {
        inFlight -= 1
        releaseIfIdle()
      }
    },
  }

  async function invokeAdmitted(request: ControlRequest, caller: ControlCaller): Promise<ControlResult> {
      const callId = ports.id()
      // A missing request key must stay absent, never an explicit undefined:
      // zod preserves explicit-undefined optional keys, so an unconditional
      // spread would poison the in-memory journal cache with values that
      // JSON.stringify silently drops on disk (#975).
      const base = { callId, instanceId: ports.instanceId, capabilityId: request.capabilityId,
        caller: `${caller.kind}:${caller.id}`, ...(request.requestKey ? { requestKey: request.requestKey } : {}) }
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
      } catch (error) {
        // No effect is allowed without a durable intent. Do not fall back to
        // console logging: that would make mutation retries impossible to audit.
        // A history that refuses on purpose (a recovered journal blocking
        // keyed intents, #1240) says why and how to clear it; any other
        // failure keeps the generic message, since raw storage errors can
        // carry local paths.
        const message = error instanceof ControlError && error.code === 'history_unavailable'
          ? error.message : 'History could not record intent; operation was not dispatched'
        return { ...controlFailure('history_unavailable', message),
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
          // Allow-list the one caller kind that may use application-only
          // capabilities instead of denying the one that may not: a caller
          // kind added later (the `agent` kind arrived this way) must start
          // out excluded rather than silently inherit settings actions.
          if (resolved.descriptor.visibility === 'application' && caller.kind !== 'application') throw new ControlError('unavailable', 'This capability is reserved for local application actions')
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
          ? controlFailure(error.code, error.message, error.outcome, error.details)
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
      // Accounting for the accepted class, from facts already computed above.
      if (result.operation?.status === 'pending') acceptedTasks.add(callId)
      if (request.capabilityId === 'operations.finish') {
        const finished = (request.input as { callId?: unknown } | undefined)?.callId
        if (typeof finished === 'string') acceptedTasks.delete(finished)
      }
      try { await write('result', result) } catch {
        // The effect may be known in this process even though its final record
        // failed. Preserve that distinction and the durable intent's call ID.
        result.operation!.historyWarning = 'Result was not persisted. A retry after restart will report an unknown outcome.'
      }
      finish(result)
      // Keep admission keys in the journal, not an unbounded live promise map.
      active.delete(callId)
      return result
  }
}
