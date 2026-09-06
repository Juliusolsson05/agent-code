import { createHash } from 'node:crypto'
import type { WorkflowService, WorkflowServiceScope } from 'workflow-mcp'

// WorkflowService's clientId is persisted attribution, not a session requirement.
// External runs get their own namespace and never invent an Agent Code parent.
// This port is consumed only by the workflow control adapter. Transport and UI
// code must not replicate its attribution/key/ownership policy.
export function externalWorkflowPort(service: WorkflowService) {
  const scope = (cwd: string, operatorId: string): WorkflowServiceScope => ({ cwd, clientId: `agent-code-external:${operatorId}` })
  const owned = async (cwd: string, operatorId: string, runId: string) => {
    const manifest = await service.status(scope(cwd, operatorId), runId)
    if (manifest.clientId !== scope(cwd, operatorId).clientId) throw new Error('This workflow belongs to another client. Use its existing owner UI for mutations.')
    return manifest
  }
  const key = (operatorId: string, callId: string) => `external:${createHash('sha256').update(JSON.stringify([operatorId, callId])).digest('hex')}`
  return {
    scope,
    owned,
    start: (cwd: string, operatorId: string, callId: string, name: string, args: unknown) =>
      service.start(scope(cwd, operatorId), { name, args, idempotencyKey: key(operatorId, callId) }),
    resume: async (cwd: string, operatorId: string, callId: string, runId: string) => {
      await owned(cwd, operatorId, runId)
      return service.resume(scope(cwd, operatorId), { runId, idempotencyKey: key(operatorId, callId) })
    },
    cancel: async (cwd: string, operatorId: string, runId: string, reason?: string) => {
      await owned(cwd, operatorId, runId)
      return service.cancel(scope(cwd, operatorId), runId, reason)
    },
  }
}
