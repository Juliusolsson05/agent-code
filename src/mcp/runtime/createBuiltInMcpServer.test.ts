import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import type { WorkflowService } from 'workflow-mcp'

import { createBuiltInMcpServer } from '@mcp/runtime/createBuiltInMcpServer.js'

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

