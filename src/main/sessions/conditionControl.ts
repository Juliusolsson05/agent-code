import { createHash } from 'node:crypto'
import { ControlError, defineCapability, conditionTargetInput, conditionReadOutput, conditionReplyInput, conditionBackendIdentity, conditionReplyOutput } from '@control-sdk'
import { makeDispatch } from '@shared/conditions-core/dispatch'
import type { SessionManager } from '@main/sessionManager'

// This adapter only consumes existing domain operations. Neither the MCP host
// nor the renderer may arbitrate between stale renderer conditions and the
// actual process; main owns both facts and checks them in one JS event turn.
export function conditionBackendCapabilities(manager: Pick<SessionManager, 'getBackendSnapshot' | 'getConditionsSnapshot' | 'write' | 'resolveCondition'>) {
  const observe = (input: { sessionId: string; cwd: string; provider: string }) => {
    const backend = manager.getBackendSnapshot(input.sessionId)
    if (!backend || backend.cwd !== input.cwd || backend.kind !== input.provider) throw new ControlError('unavailable', 'The backend no longer matches the window agent')
    const snapshot = manager.getConditionsSnapshot(input.sessionId)
    const conditions = Object.values(snapshot?.conditions ?? {}).filter(item => item != null)
    // Snapshot timestamps change on polling even when the dialog is identical.
    // Hash the actual state/actions and the process generation, including raw
    // action data which is intentionally absent from the operator-facing list.
    const revision = createHash('sha256').update(JSON.stringify([backend.sessionRunId, snapshot?.provider, conditions])).digest('hex')
    return { backend, conditions, revision }
  }
  return [
    defineCapability({
      id: 'sessions.conditionsRead', visibility: 'application', title: 'Read authoritative conditions', execution: 'main', effect: 'read',
      description: 'Backing operation for the owning window; reads current backend conditions without spawning or attaching.',
      input: conditionTargetInput.extend(conditionBackendIdentity.shape), output: conditionReadOutput,
      handler: input => {
        const { backend, conditions, revision } = observe(input)
        return { sessionId: input.sessionId, sessionRunId: backend.sessionRunId ?? null, revision,
          conditions: conditions.map(condition => ({ kind: condition.kind, state: conditionReadOutput.shape.conditions.element.shape.state.parse(condition.state),
            actions: condition.actions.map(({ id, kind, label }) => ({ id, kind, label })) })) }
      },
    }),
    defineCapability({
      id: 'sessions.conditionsReply', visibility: 'application', title: 'Reply to an authoritative condition', execution: 'main', effect: 'mutation', completion: 'accepted',
      description: 'Backing operation; checks backend lifetime and exact condition revision immediately before dispatching an advertised action.',
      input: conditionReplyInput.extend(conditionBackendIdentity.shape), output: conditionReplyOutput,
      handler: async input => {
        const { backend, conditions, revision } = observe(input)
        if (!backend.sessionRunId || input.revision !== revision) throw new ControlError('stale_cursor', 'Condition or backend changed; read conditions again')
        const condition = conditions.find(condition => condition.kind === input.kind)
        const actions = condition?.actions.filter(action => action.id === input.actionId) ?? []
        if (actions.length !== 1) throw new ControlError('unavailable', 'No unique advertised action; inspect the current condition UI')
        // makeDispatch calls its injected writer synchronously before its first
        // await. No event may replace the backend between observe and admission.
        // The manager preserves its existing prompt-delivery reservation checks.
        await makeDispatch(input.sessionId, async (id, data) => {
          if (!manager.write(id, data)) throw new ControlError('unavailable', 'Backend refused input; observe before retrying')
        }, async (id, action) => {
          const result = await manager.resolveCondition(id, action)
          if (!result.ok) throw new ControlError('failed', JSON.stringify(result), 'unknown')
        })(actions[0])
        return { sessionId: input.sessionId, sessionRunId: backend.sessionRunId, actionId: input.actionId, accepted: true as const }
      },
    }),
  ]
}
