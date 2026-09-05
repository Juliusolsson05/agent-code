import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode, type Tool } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { operatorRoutingSchema, controlOperationSchema, controlResultSchema, paginate, type CapabilityDescriptor, type ControlOperatorPort, type ControlOwner } from '@control-sdk'

export const toolName = (id: string) => `ac_${id.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replaceAll('.', '_').toLowerCase()}`

function descriptors(port: ControlOperatorPort): CapabilityDescriptor[] {
  const unique = new Map<string, CapabilityDescriptor>()
  for (const { descriptor } of port.catalog()) {
    if (descriptor.visibility === 'application') continue
    const prior = unique.get(descriptor.id)
    if (prior && JSON.stringify(prior) !== JSON.stringify(descriptor)) throw new McpError(ErrorCode.InternalError, `Window capability schemas disagree: ${descriptor.id}`)
    unique.set(descriptor.id, descriptor)
  }
  return [...unique.values()].sort((a, b) => a.id.localeCompare(b.id))
}

// Tool docs are consumed without the app's internal SDK vocabulary. Translate
// references only inside schema/description metadata, never user prompts or
// returned conversation strings. Feature owners still maintain a single source.
function publishedSchema(value: unknown, ids: Set<string>, pointer = ''): unknown {
  if (Array.isArray(value)) return value.map(item => publishedSchema(item, ids, pointer))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    key === 'description' && typeof item === 'string' ? publishedDescription(item, ids)
      : key === '$ref' && typeof item === 'string' && item.startsWith('#/') && pointer ? `#${pointer}${item.slice(1)}`
      : publishedSchema(item, ids, pointer),
  ]))
}
function publishedDescription(text: string, ids: Set<string>): string {
  return text.replace(/\b[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+\b/g, id => ids.has(id) ? toolName(id) : id)
}
function tool(descriptor: CapabilityDescriptor, ids: Set<string>): Tool {
  const input = publishedSchema(descriptor.inputSchema, ids) as Record<string, unknown>
  if (input.type !== 'object' || (input.properties as Record<string, unknown>)?._control) throw new Error(`Capability cannot be wrapped: ${descriptor.id}`)
  return {
    name: toolName(descriptor.id), title: descriptor.title,
    description: `${publishedDescription(descriptor.description, ids)}\n${descriptor.execution === 'window'
      ? 'For multiple windows, pass _control.windowId from ac_app_windows. Agent/project targets otherwise resolve across all windows; ambiguous targets fail. Focus is never an implicit selection.'
      : 'Application-wide operation.'} ${descriptor.completion === 'accepted' ? 'Success acknowledges acceptance; inspect state/read output for completion.' : ''} Returns {ok, value or error, operation}; operation.callId identifies its durable history.`,
    inputSchema: { ...input, type: 'object', properties: { ...(input.properties as object), _control: z.toJSONSchema(descriptor.execution === 'window' ? operatorRoutingSchema : operatorRoutingSchema.pick({ requestKey: true })) } },
    // The wrapper returns the SDK envelope, not the naked feature value. Its
    // published output schema must describe that actual shape. Rebase nested
    // schema references when embedding value so recursive schemas stay valid.
    outputSchema: { type: 'object', additionalProperties: false, required: ['ok'],
      properties: { ok: { type: 'boolean' },
        value: publishedSchema(descriptor.outputSchema, ids, '/properties/value') as Record<string, unknown>,
        error: z.toJSONSchema(controlResultSchema.options[1].shape.error),
        operation: { ...z.toJSONSchema(controlOperationSchema), description: 'Execution receipt. pending means accepted, ui_opened means the surface was acknowledged, outcome_unknown requires observation before another effect. callId supports full history retrieval.' },
      },
      oneOf: [
        { properties: { ok: { const: true } }, required: ['value'], not: { required: ['error'] } },
        { properties: { ok: { const: false } }, required: ['error'], not: { required: ['value'] } },
      ],
    },
    // MCP annotations are client hints, never permission or admission rules.
    // A read can still observe private prompt history. Mutation retries remain
    // controlled by the SDK's durable request key, not an idempotentHint guess.
    annotations: { readOnlyHint: descriptor.effect === 'read', destructiveHint: descriptor.effect === 'mutation', openWorldHint: true },
  }
}

export function createOperatorMcpServer(port: ControlOperatorPort): Server {
  const server = new Server({ name: 'agent-code-control', version: '1.0.0' }, { capabilities: { tools: {} },
    instructions: 'Start with ac_app_describe for the Agent Code crash course and ac_app_windows / ac_app_observe for window IDs and current UI. Use ac_agents_search to find existing agents before creating one. This server complements computer use. Explicit _control.windowId selects a window; a sessionId normally routes itself. Every operation returns a durable call ID for ac_history_read. Default ac_agents_read includes prompts and assistant prose. Follow continuations; do not interpret prompt acceptance as task completion. This server is reserved for an external operator and is not installed in Agent Code agents.' })
  server.setRequestHandler(ListToolsRequestSchema, async request => {
    const catalog = descriptors(port)
    const ids = new Set(catalog.map(item => item.id))
    const all = catalog.map(descriptor => tool(descriptor, ids))
    if (new Set(all.map(item => item.name)).size !== all.length) throw new McpError(ErrorCode.InternalError, 'Control tool names collide')
    const page = paginate(all, { limit: 100, cursor: request.params?.cursor }, 'external-tools-v1')
    return { tools: page.items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) }
  })
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const descriptor = descriptors(port).find(item => toolName(item.id) === request.params.name)
    if (!descriptor) throw new McpError(ErrorCode.InvalidParams, `Unknown control tool: ${request.params.name}. Refresh tools/list.`)
    const { _control, ...input } = request.params.arguments ?? {}
    const routingSchema = descriptor.execution === 'window' ? operatorRoutingSchema : operatorRoutingSchema.pick({ requestKey: true })
    const parsed = routingSchema.safeParse(_control ?? {})
    if (!parsed.success) throw new McpError(ErrorCode.InvalidParams, parsed.error.message)
    const routing = parsed.data as z.infer<typeof operatorRoutingSchema>
    if (routing.generation && !routing.windowId) throw new McpError(ErrorCode.InvalidParams, 'generation requires windowId')
    let owner: ControlOwner | undefined
    if (routing.windowId) {
      if (descriptor.execution === 'main') throw new McpError(ErrorCode.InvalidParams, 'This operation is application-wide; omit windowId')
      const live = port.catalog().find(row => row.descriptor.id === descriptor.id && row.owner.kind === 'window' && row.owner.windowId === routing.windowId)?.owner
      owner = { kind: 'window', windowId: routing.windowId, generation: routing.generation ?? live?.generation ?? 'unregistered' }
    }
    const result = await port.invoke({ capabilityId: descriptor.id, input, ...(owner ? { owner } : {}),
      ...(routing.requestKey ? { requestKey: routing.requestKey } : {}) })
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result as Record<string, unknown>, isError: !result.ok }
  })
  return server
}
