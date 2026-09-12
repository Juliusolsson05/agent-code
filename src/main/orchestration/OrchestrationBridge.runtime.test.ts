import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentProviderKind } from '@shared/types/providerKind.js'
import type { OrchestrationRendererRequest } from '@mcp/shared/orchestrationTypes.js'
import { OrchestrationBridge } from './OrchestrationBridge.js'
import { createBuiltInMcpServer } from '@mcp/runtime/createBuiltInMcpServer.js'

const seam = vi.hoisted(() => ({
  send: vi.fn(),
  terminalProviders: new Set<AgentProviderKind>(['opencode']),
}))
vi.mock('@main/window/windowRegistry.js', () => ({
  windowForSession: () => 'parent-window',
  sendToWindow: (...args: unknown[]) => seam.send(...args),
}))
vi.mock('@providers/registry.main.js', () => ({
  getMainProvider: (kind: AgentProviderKind) => ({
    name: { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' }[kind],
    createTerminalSession: seam.terminalProviders.has(kind) ? () => undefined : undefined,
  }),
}))
beforeEach(() => {
  seam.send.mockReset()
  seam.terminalProviders = new Set(['opencode'])
})
afterEach(() => { vi.restoreAllMocks() })

async function withMcp(run: (context: {
  client: Client
  requests: OrchestrationRendererRequest[]
  deliverPromptToAgent: ReturnType<typeof vi.fn>
}) => Promise<void>) {
  const bridge = new OrchestrationBridge()
  const requests: OrchestrationRendererRequest[] = []
  const child = {
    sessionId: 'child', kind: 'opencode' as const, cwd: '/repo',
    orchestrationParentId: 'parent', orchestrationRootId: 'root',
    orchestrationRunId: 'run', orchestrationRole: 'reviewer',
  }
  // Main-only test boundary: the real MCP schema and bridge run, while this
  // renderer stand-in acknowledges requests. The renderer test separately
  // proves actual pane/spawn handling rather than trusting this acknowledgment.
  seam.send.mockImplementation((_window: string, _channel: string, request: OrchestrationRendererRequest) => {
    requests.push(request)
    queueMicrotask(() => {
      if (request.type === 'create-agent' || request.type === 'mark-bootstrap-prompt-delivered') {
        bridge.resolve({ requestId: request.requestId, type: request.type, ok: true, agent: child })
      } else if (request.type === 'list-agents') {
        bridge.resolve({ requestId: request.requestId, type: request.type, ok: true, agents: [child] })
      } else {
        bridge.resolve({ requestId: request.requestId, type: request.type, ok: false, message: 'Unexpected request in create test' })
      }
    })
  })
  const deliverPromptToAgent = vi.fn(async () => ({ ok: true as const }))
  const server = createBuiltInMcpServer({ sessionId: 'parent', cwd: '/repo', domains: ['orchestration'] }, {
    orchestrationBridge: bridge,
    // Only delivery is involved in this MCP operation; no provider is started.
    sessionManager: { deliverPromptToAgent } as never,
  })
  const client = new Client({ name: 'orchestration-runtime-test', version: '0.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  try {
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    await run({ client, requests, deliverPromptToAgent })
  } finally {
    await client.close()
    await server.close()
  }
}

function resultText(result: Awaited<ReturnType<Client['callTool']>>): string {
  return (result.content as Array<{ text: string }>)[0]!.text
}

describe('orchestration create runtime schema and bridge', () => {
  it('advertises the terminal enum and passes it to the renderer with the scoped parent', async () => {
    await withMcp(async ({ client, requests, deliverPromptToAgent }) => {
      const tool = (await client.listTools()).tools.find(tool => tool.name === 'orchestration_create_agent')!
      expect(tool.inputSchema.properties?.providerRuntime).toMatchObject({ type: 'string', enum: ['terminal'] })
      expect(tool.description).toContain('native TUI in the pane')
      const result = await client.callTool({ name: 'orchestration_create_agent', arguments: {
        kind: 'opencode', providerRuntime: 'terminal', prompt: 'Review the parser', role: 'reviewer', runId: 'run',
      } })
      expect(result.isError).not.toBe(true)
      expect(requests[0]).toMatchObject({ type: 'create-agent', parentSessionId: 'parent', kind: 'opencode', providerRuntime: 'terminal', role: 'reviewer', runId: 'run' })
      expect(deliverPromptToAgent).toHaveBeenCalledExactlyOnceWith('child', expect.stringContaining('<task>\nReview the parser\n</task>'))
      expect(JSON.parse(resultText(result))).toMatchObject({ ok: true, promptSubmitted: true, agent: { sessionId: 'child' } })
    })
  })

  it('preserves omitted runtime rather than inheriting or defaulting it', async () => {
    await withMcp(async ({ client, requests }) => {
      const result = await client.callTool({ name: 'orchestration_create_agent', arguments: { kind: 'opencode' } })
      expect(result.isError).not.toBe(true)
      expect(requests[0]).toMatchObject({ kind: 'opencode' })
      expect(requests[0]).not.toHaveProperty('providerRuntime')
    })
  })

  it('rejects unknown runtime values at the schema before creating a child', async () => {
    await withMcp(async ({ client, requests, deliverPromptToAgent }) => {
      const result = await client.callTool({ name: 'orchestration_create_agent', arguments: { kind: 'opencode', providerRuntime: 'desktop' } })
      expect(result.isError).toBe(true)
      expect(resultText(result)).toContain('providerRuntime')
      expect(requests).toEqual([])
      expect(deliverPromptToAgent).not.toHaveBeenCalled()
    })
  })

  it('rejects Claude terminal at the capability boundary before renderer or prompt work', async () => {
    await withMcp(async ({ client, requests, deliverPromptToAgent }) => {
      const result = await client.callTool({ name: 'orchestration_create_agent', arguments: { kind: 'claude', providerRuntime: 'terminal', prompt: 'Review' } })
      expect(result.isError).toBe(true)
      expect(resultText(result)).toContain('Claude Code does not support a terminal runtime')
      expect(requests).toEqual([])
      expect(deliverPromptToAgent).not.toHaveBeenCalled()
    })
  })

  it('uses declared capabilities rather than special-casing OpenCode', async () => {
    seam.terminalProviders = new Set(['codex'])
    await withMcp(async ({ client, requests }) => {
      const accepted = await client.callTool({ name: 'orchestration_create_agent', arguments: { kind: 'codex', providerRuntime: 'terminal' } })
      expect(accepted.isError).not.toBe(true)
      expect(requests[0]).toMatchObject({ kind: 'codex', providerRuntime: 'terminal' })
      const count = requests.length
      const rejected = await client.callTool({ name: 'orchestration_create_agent', arguments: { kind: 'opencode', providerRuntime: 'terminal' } })
      expect(rejected.isError).toBe(true)
      expect(resultText(rejected)).toContain('OpenCode does not support a terminal runtime')
      expect(requests).toHaveLength(count)
    })
  })
})
