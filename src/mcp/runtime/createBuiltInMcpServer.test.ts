import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, vi } from 'vitest'
import type { WorkflowService } from 'workflow-mcp'

import { createBuiltInMcpServer } from '@mcp/runtime/createBuiltInMcpServer.js'
import type { BuiltInMcpDomain } from '@mcp/shared/types.js'
import type { PromptDeliveryResult } from '@shared/types/providerConfig.js'

async function toolNames(domains: BuiltInMcpDomain[]): Promise<string[]> {
  const server = createBuiltInMcpServer(
    { sessionId: 'session-1', cwd: '/tmp/project', domains },
    { workflowService: {} as WorkflowService },
  )
  const client = new Client({ name: 'workflow-domain-test', version: '0.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

  try {
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    return (await client.listTools()).tools.map(tool => tool.name)
  } finally {
    await client.close()
    await server.close()
  }
}

async function agentManagementSurface(): Promise<{
  tools: Awaited<ReturnType<Client['listTools']>>['tools']
  instructions: string | undefined
}> {
  const server = createBuiltInMcpServer(
    { sessionId: 'session-1', cwd: '/tmp/project', domains: ['agent_management'] },
  )
  const client = new Client({ name: 'agent-management-domain-test', version: '0.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  try {
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    return {
      tools: (await client.listTools()).tools,
      instructions: client.getInstructions(),
    }
  } finally {
    await client.close()
    await server.close()
  }
}

async function createAgentWithDelivery(delivery: PromptDeliveryResult): Promise<{
  value: Record<string, unknown>
  closeAgent: ReturnType<typeof vi.fn>
}> {
  const agent = {
    sessionId: 'child-1',
    kind: 'claude' as const,
    cwd: '/tmp/project',
    orchestrationParentId: 'session-1',
    orchestrationRootId: 'session-1',
  }
  const closeAgent = vi.fn(async () => ({ closedSessionIds: ['child-1'] }))
  const server = createBuiltInMcpServer(
    { sessionId: 'session-1', cwd: '/tmp/project', domains: ['orchestration'] },
    {
      orchestrationBridge: {
        createAgent: vi.fn(async () => agent),
        closeAgent,
      } as never,
      sessionManager: {
        deliverPromptToAgent: vi.fn(async () => delivery),
      } as never,
    },
  )
  const client = new Client({ name: 'prompt-disposition-test', version: '0.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  try {
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    const result = await client.callTool({
      name: 'orchestration_create_agent',
      arguments: { kind: 'claude', prompt: 'Review this' },
    })
    const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? '{}'
    return { value: JSON.parse(text) as Record<string, unknown>, closeAgent }
  } finally {
    await client.close()
    await server.close()
  }
}

async function sendManagedPromptWithDelivery(delivery: PromptDeliveryResult): Promise<Record<string, unknown>> {
  const server = createBuiltInMcpServer(
    { sessionId: 'session-1', cwd: '/tmp/project', domains: ['agent_management'] },
    {
      agentManagementBridge: {
        sendPrompt: vi.fn(async () => delivery),
      } as never,
    },
  )
  const client = new Client({ name: 'agent-management-delivery-test', version: '0.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  try {
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    const result = await client.callTool({
      name: 'agent_management_send_prompt',
      arguments: { sessionId: 'agent-1', prompt: 'Run this once' },
    })
    const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? '{}'
    return JSON.parse(text) as Record<string, unknown>
  } finally {
    await client.close()
    await server.close()
  }
}

describe('createBuiltInMcpServer workflow domain', () => {
  it('registers workflow tools only for sessions carrying the workflows domain', async () => {
    const workflowTools = await toolNames(['workflows'])
    expect(workflowTools).toEqual(expect.arrayContaining([
      'workflow_list',
      'workflow_describe',
      'workflow_validate',
      'workflow_run',
      'workflow_run_status',
      'workflow_run_events',
      'workflow_run_cancel',
      'workflow_resume',
    ]))

    const transcriptTools = await toolNames(['agent_transcripts'])
    expect(transcriptTools.some(name => name.startsWith('workflow_'))).toBe(false)
  })
})

describe('createBuiltInMcpServer Agent Management domain', () => {
  it('registers the five project-management tools only for the selected domain', async () => {
    expect(await toolNames(['agent_management'])).toEqual([
      'agent_management_list_agents',
      'agent_management_read_agent',
      'agent_management_read_agents',
      'agent_management_send_prompt',
      'agent_management_close_agent',
    ])
    expect((await toolNames(['agent_transcripts']))
      .some(name => name.startsWith('agent_management_'))).toBe(false)
  })

  it('puts explicit current-user authorization on both server and destructive tool metadata', async () => {
    const { tools, instructions } = await agentManagementSurface()
    expect(instructions).toContain('current request explicitly asks')
    expect(instructions).toContain('safe to clean up is not authorization')
    expect(instructions).toContain('missing or truncated transcript is not an empty transcript')
    expect(instructions).toContain('unresolved latest user request')
    expect(instructions).toContain('cannot prove a worktree is clean')
    const close = tools.find(tool => tool.name === 'agent_management_close_agent')
    expect(close?.description).toContain('Call only when the current user explicitly asks')
    expect((close?.inputSchema as { properties?: Record<string, unknown> })?.properties)
      .not.toHaveProperty('confirmed')
    expect(close?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    })
  })

  it('derives caller authority from the authenticated MCP scope', async () => {
    const listAgents = vi.fn(async () => ({
      observedAt: 10_000,
      project: { tabId: 'tab-1', title: 'Project', index: 0 },
      agents: [],
    }))
    const server = createBuiltInMcpServer(
      { sessionId: 'authenticated-caller', cwd: '/tmp/project', domains: ['agent_management'] },
      { agentManagementBridge: { listAgents } as never },
    )
    const client = new Client({ name: 'agent-management-scope-test', version: '0.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    try {
      await server.connect(serverTransport)
      await client.connect(clientTransport)
      await client.callTool({ name: 'agent_management_list_agents', arguments: {} })
      expect(listAgents).toHaveBeenCalledWith({ callerSessionId: 'authenticated-caller' })
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('promotes provider delivery uncertainty to a top-level tool failure', async () => {
    const value = await sendManagedPromptWithDelivery({
      ok: false,
      stage: 'after-enter',
      code: 'acceptance-timeout',
      message: 'Prompt may already have been submitted',
      retrySafe: false,
      disposition: 'do-not-retry',
      promptWritten: true,
      enterWritten: true,
    })

    expect(value).toMatchObject({
      ok: false,
      error: 'prompt_delivery_failed',
      sessionId: 'agent-1',
      retrySafe: false,
      disposition: 'do-not-retry',
      promptSubmission: 'uncertain',
    })
  })
})

describe('orchestration create-agent delivery disposition', () => {
  it('preserves a healthy child when readiness merely needs more time', async () => {
    const { value, closeAgent } = await createAgentWithDelivery({
      ok: false,
      stage: 'before-write',
      code: 'not-ready',
      message: 'composer still warming',
      retrySafe: true,
      disposition: 'retry-same-session',
      promptWritten: false,
      enterWritten: false,
    })

    expect(value).toMatchObject({
      ok: false,
      sessionId: 'child-1',
      disposition: 'retry-same-session',
      cleanupAttempted: false,
      agentClosed: false,
    })
    expect(closeAgent).not.toHaveBeenCalled()
  })

  it('closes only a child the provider classified as unusable', async () => {
    const { value, closeAgent } = await createAgentWithDelivery({
      ok: false,
      stage: 'before-write',
      code: 'missing-capability',
      message: 'headless runtime unavailable',
      retrySafe: true,
      disposition: 'session-unusable',
      promptWritten: false,
      enterWritten: false,
    })

    expect(value).toMatchObject({
      ok: false,
      disposition: 'session-unusable',
      cleanupAttempted: true,
      agentClosed: true,
    })
    expect(closeAgent).toHaveBeenCalledOnce()
  })
})

describe('createBuiltInMcpServer root management domain (#906)', () => {
  async function surface(domains: BuiltInMcpDomain[], dependencies: Parameters<typeof createBuiltInMcpServer>[1]) {
    const server = createBuiltInMcpServer({ sessionId: 'session-9', cwd: '/tmp/project', domains }, dependencies)
    const client = new Client({ name: 'root-management-test', version: '0.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    try {
      await server.connect(serverTransport)
      await client.connect(clientTransport)
      return { names: (await client.listTools()).tools.map(tool => tool.name), instructions: client.getInstructions() ?? '' }
    } finally {
      await client.close()
      await server.close()
    }
  }

  it('hands the session server to the injected operator projection and teaches the root rules', async () => {
    const rootControlTools = vi.fn((server: McpServer, sessionId: string) => {
      server.registerTool(`ac_probe_${sessionId.replaceAll('-', '_')}`, { description: 'probe', inputSchema: {} }, async () => ({ content: [] }))
    })
    const result = await surface(['root_management', 'agent_management'], { rootControlTools })
    expect(rootControlTools).toHaveBeenCalledWith(expect.anything(), 'session-9')
    expect(result.names).toContain('ac_probe_session_9')
    expect(result.names).toContain('agent_management_list_agents')
    // The rules a root-managed agent must not lose: it knows its own session,
    // it treats "tidy the workspace" as placement-only authorization, and a
    // declined confirmation is final.
    expect(result.instructions).toContain('session ID is session-9')
    expect(result.instructions).toContain('placement, focus, pin and title changes only')
    expect(result.instructions).toContain('declined dialog is a refusal')
  })

  it('registers nothing and stays silent about root tools without the domain or without a registrar', async () => {
    const rootControlTools = vi.fn()
    const withoutDomain = await surface(['agent_management'], { rootControlTools })
    expect(rootControlTools).not.toHaveBeenCalled()
    expect(withoutDomain.names.some(name => name.startsWith('ac_'))).toBe(false)
    expect(withoutDomain.instructions).not.toContain('Root Agent Code Management')

    // Paired with another domain because the SDK answers tools/list with
    // "Method not found" for a server that registered no tool at all; the
    // contract under test is that root contributes nothing when unwired.
    const record = vi.fn()
    const unwired = await surface(['root_management', 'agent_management'], { appRunJournal: { record } as never })
    expect(unwired.names.some(name => name.startsWith('ac_'))).toBe(false)
    expect(unwired.instructions).not.toContain('Root Agent Code Management')
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ area: 'mcp.root_management', name: 'registrar.missing' }))
  })
})
