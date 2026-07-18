import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, vi } from 'vitest'
import type { WorkflowService } from 'workflow-mcp'

import { createBuiltInMcpServer } from '@mcp/runtime/createBuiltInMcpServer.js'
import type { PromptDeliveryResult } from '@shared/types/providerConfig.js'

async function toolNames(domains: Array<'workflows' | 'agent_transcripts'>): Promise<string[]> {
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
