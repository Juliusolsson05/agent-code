import { z } from 'zod'
import { ControlError, controlFailure, type ControlContext, type ControlResult, type ControlRequest } from './contracts'

// A lifecycle operation outlives the MCP request, but never loses its durable
// call identity. The caller supplies an already-captured domain target, and the
// task body must still revalidate it after admission's IPC await. This launcher
// knows nothing about close/provider/rewind policy and must stay that way.
export async function startControlTask(context: ControlContext, invoke: (request: ControlRequest) => Promise<ControlResult>, run: () => Promise<unknown>) {
  const callId = context.operationId ?? context.requestId
  const admitted = await invoke({ capabilityId: 'operations.start', input: { callId, owner: context.owner }, requestKey: `task-start:${callId}` })
  if (!admitted.ok) throw new ControlError(admitted.error.code, admitted.error.message, admitted.error.outcome)
  void (async () => {
    let result: ControlResult
    try { result = { ok: true, value: z.json().parse(await run()) } }
    catch (error) {
      result = error instanceof ControlError ? controlFailure(error.code, error.message, error.outcome)
        : controlFailure('failed', error instanceof Error ? error.message : 'Lifecycle operation failed', 'unknown')
    }
    // No automatic retry with a new intention: the domain may already have
    // performed its effect. A failed result journal write leaves the task
    // unresolved and the separate reporting call carries the failure evidence.
    const recorded = await invoke({ capabilityId: 'operations.finish', input: { callId, result }, requestKey: `task-finish:${callId}` })
    if (!recorded.ok) console.warn('[control] lifecycle result was not recorded', callId, recorded.error.code)
  })().catch(() => console.warn('[control] lifecycle reporting transport ended', callId))
  return { callId, accepted: true as const }
}
