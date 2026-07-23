import { Client } from '@modelcontextprotocol/sdk/client/index.js'
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
