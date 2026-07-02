import { describe, expect, it, vi } from 'vitest'

const sentRendererRequests: unknown[] = []

vi.mock('@main/window/mainWindow.js', () => ({
  sendToMainWindow: (_channel: string, request: unknown) => {
    sentRendererRequests.push(request)
  },
}))

const { OrchestrationBridge } = await import('@main/orchestration/OrchestrationBridge.js')

describe('OrchestrationBridge status cache', () => {
  it('joins identical list-agents reads inside the short polling window', async () => {
    sentRendererRequests.length = 0
    const bridge = new OrchestrationBridge()

    const first = bridge.listAgents({ parentSessionId: 'parent-1', runId: 'run-a' })
    const second = bridge.listAgents({ parentSessionId: 'parent-1', runId: 'run-a' })

    expect(sentRendererRequests).toHaveLength(1)
    const request = sentRendererRequests[0] as { requestId: string; type: string }
    expect(request.type).toBe('list-agents')

    bridge.resolve({
      requestId: request.requestId,
      ok: true,
      type: 'list-agents',
      agents: [
        {
          sessionId: 'child-1',
          kind: 'claude',
          cwd: '/tmp/project',
          orchestrationParentId: 'parent-1',
          orchestrationRootId: 'parent-1',
          orchestrationRunId: 'run-a',
        },
      ],
    })

    await expect(first).resolves.toHaveLength(1)
    await expect(second).resolves.toHaveLength(1)
  })

  it('invalidates aggregate status caches after prompt submission metadata changes', async () => {
    sentRendererRequests.length = 0
    const bridge = new OrchestrationBridge()

    const first = bridge.listAgents({ parentSessionId: 'parent-1' })
    const firstRequest = sentRendererRequests[0] as { requestId: string }
    bridge.resolve({
      requestId: firstRequest.requestId,
      ok: true,
      type: 'list-agents',
      agents: [],
    })
    await first

    bridge.notePromptSubmitted('child-1')

    const second = bridge.listAgents({ parentSessionId: 'parent-1' })
    expect(sentRendererRequests).toHaveLength(2)
    const secondRequest = sentRendererRequests[1] as { requestId: string }
    bridge.resolve({
      requestId: secondRequest.requestId,
      ok: true,
      type: 'list-agents',
      agents: [],
    })
    await second
  })
})
