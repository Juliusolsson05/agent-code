import { z } from 'zod'
import { defineCapability, paginate, pageInput, pageSchema, startControlTask, type ControlContext, type ControlRequest, type ControlResult } from '@control-sdk'
import { WorkflowServiceError, type WorkflowService } from 'workflow-mcp'
import { externalWorkflowPort } from './externalOperator/port'
import { workflowPayloadForRenderer } from './workflowPayloadForRenderer'

const cwd = z.string().min(1).describe('Exact project working directory. Workflow discovery and all run reads are scoped to this directory.')
const run = z.object({ cwd, runId: z.string().min(1).describe('Workflow run_* identity, not an Agent Code session ID or task callId.') }).strict()
const json = (value: unknown) => z.json().parse(JSON.parse(JSON.stringify(value)))
const accepted = z.object({ callId: z.string(), accepted: z.literal(true) })
type TaskInvoke = (context: ControlContext, request: ControlRequest) => Promise<ControlResult>
export function workflowControlCapabilities(service: WorkflowService, invokeTask: TaskInvoke) {
  const port = externalWorkflowPort(service)
  const operator = (context: ControlContext) => `${context.caller.kind}:${context.caller.id}`
  const scope = (directory: string, context: ControlContext) => port.scope(directory, operator(context))
  const launch = (context: ControlContext, operation: () => Promise<unknown>) => startControlTask(context, request => invokeTask(context, request), operation,
    (id, code) => console.warn('[control] workflow task reporting failed', id, code))
  return [
    defineCapability({ id: 'workflows.list', title: 'Discover existing project workflows', execution: 'main', effect: 'read',
      description: 'Find existing workflow definitions visible to this project using the ordinary workflow service. Returns metadata, source hash and location without executing source. Discovery issues are separate from an empty catalog. This toolkit runs existing definitions; it does not author arbitrary workflow JavaScript.',
      input: z.object({ cwd, ...pageInput }).strict(), output: pageSchema(z.json()).extend({ issues: z.array(z.json()) }),
      handler: async (input, context) => {
        const found = await service.list(scope(input.cwd, context))
        return { ...paginate(found.workflows.map(({ meta, sourceHash, filePath, location }) => json({ ...meta, sourceHash, filePath, location })), input, `workflows:${input.cwd}`), issues: found.issues.map(json) }
      },
    }),
    defineCapability({ id: 'workflows.start', title: 'Start an externally owned workflow', execution: 'main', effect: 'mutation', completion: 'accepted',
      description: 'Start an existing named workflow under explicit external-operator ownership, with JSON arguments. The ordinary exact-source approval dialog, isolated worker, authentication and read-only execution policy still apply. May require computer use to approve the source. Returns a task callId immediately; operations.read gives runId after admission. Then workflows.status/result report actual completion. No internal agent parent is fabricated, and workers remain excluded from the operator MCP/skill.',
      input: z.object({ cwd, name: z.string().min(1), args: z.json().default(null) }).strict(), output: accepted,
      handler: (input, context) => launch(context, () => port.start(input.cwd, operator(context), context.operationId ?? context.requestId, input.name, input.args)),
    }),
    defineCapability({ id: 'workflows.runs', title: 'Page workflow run inventory for a project', execution: 'main', effect: 'read',
      description: 'Read a bounded run-inventory page filtered to the named project. An empty page can still have nextCursor because other projects occupied that underlying page. Reports persisted owner attribution and whether this caller owns each run. Read-only inspection can include internal runs; cancellation/resume are limited to your external-owned runs.',
      input: z.object({ cwd, cursor: z.string().optional(), limit: z.number().int().min(1).max(50).default(20) }).strict(), output: z.object({ items: z.array(z.json()), nextCursor: z.string().nullable(), hasMore: z.boolean() }),
      handler: async (input, context) => {
        const page = await service.listRuns({ cursor: input.cursor, limit: input.limit })
        const items: ReturnType<typeof json>[] = []
        for (const row of page.items) {
          try {
            const manifest = await service.status(scope(input.cwd, context), row.runId)
            items.push(json({ ...row, clientId: manifest.clientId ?? null, ownedByCaller: manifest.clientId === scope(input.cwd, context).clientId }))
          } catch (error) { if (!(error instanceof WorkflowServiceError) || error.code !== 'scope-forbidden') throw error }
        }
        return { items, nextCursor: page.nextCursor ?? null, hasMore: page.hasMore }
      },
    }),
    defineCapability({ id: 'workflows.status', title: 'Read a workflow outcome and ownership', execution: 'main', effect: 'read',
      description: 'Read persisted workflow status and compact result reference, including external/internal owner attribution. Process liveness is not workflow completion. Large result content remains behind its artifact reference; workflows.result pages the full bytes. This never resumes or starts workers.',
      input: run, output: z.object({ manifest: z.json(), ownedByCaller: z.boolean() }),
      handler: async (input, context) => {
        const manifest = await service.status(scope(input.cwd, context), input.runId)
        return { manifest: json(workflowPayloadForRenderer(manifest)), ownedByCaller: manifest.clientId === scope(input.cwd, context).clientId }
      },
    }),
    defineCapability({ id: 'workflows.events', title: 'Read workflow progress events', execution: 'main', effect: 'read',
      description: 'Read up to 20 durable workflow events after an event cursor. Uses the existing compact UI content projection; heavy content references report truncation and retain artifact locators. Follow toCursor while hasMore. Does not long-poll or start a worker; use workflows.result for full final output.',
      input: run.extend({ after: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(20).default(10) }), output: z.object({ page: z.json() }),
      handler: async (input, context) => ({ page: json(workflowPayloadForRenderer(await service.readEvents(scope(input.cwd, context), { runId: input.runId, after: input.after, limit: input.limit }))) }),
    }),
    defineCapability({ id: 'workflows.result', title: 'Read full workflow result bytes', execution: 'main', effect: 'read',
      description: 'Page the immutable final result artifact named in workflows.status. Supply its artifactId and follow nextCursor without manufacturing offsets. Returns full available bytes in bounded UTF-8 pages; this is distinct from compact event/status previews.',
      input: run.extend({ artifactId: z.string().min(1), cursor: z.string().optional(), maxBytes: z.number().int().min(256).max(65536).default(16000) }), output: z.object({ page: z.json() }),
      handler: async (input, context) => ({ page: json(await service.readResult(scope(input.cwd, context), input)) }),
    }),
    defineCapability({ id: 'workflows.cancel', title: 'Cancel an externally owned workflow', execution: 'main', effect: 'mutation', completion: 'accepted',
      description: 'Request ordinary cancellation for a run owned by this external caller. Does not claim that provider descendants are dead merely because cancellation was requested. Returns task callId; operations.read and workflows.status expose the outcome. Runs owned by internal sessions or another client retain their existing owner UI.',
      input: run.extend({ reason: z.string().max(2000).optional() }), output: accepted,
      handler: async (input, context) => {
        await port.owned(input.cwd, operator(context), input.runId)
        return launch(context, async () => json(workflowPayloadForRenderer(await port.cancel(input.cwd, operator(context), input.runId, input.reason))))
      },
    }),
    defineCapability({ id: 'workflows.resume', title: 'Resume an externally owned workflow', execution: 'main', effect: 'mutation', completion: 'accepted',
      description: 'Resume your externally owned run through the existing recovery policy, producing a linked successor run rather than reviving an internal agent. Source approval and unsafe-provider fences remain in force; this tool cannot abandon an unconfirmed live provider. Read operations.read for the successor runId, then workflows.status.',
      input: run, output: accepted,
      handler: async (input, context) => {
        await port.owned(input.cwd, operator(context), input.runId)
        return launch(context, () => port.resume(input.cwd, operator(context), context.operationId ?? context.requestId, input.runId))
      },
    }),
  ]
}
