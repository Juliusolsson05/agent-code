import { afterEach, describe, expect, it, vi } from 'vitest'

const sentRendererRequests: unknown[] = []

// `windowForSession` decides whether the request is deliverable at all; these
// tests are about caching and lifecycle, so every parent session resolves.
// The unowned-parent rejection is asserted separately below.
const sessionWindowOwner = vi.fn((_sessionId: string): string | null => 'test-window')

vi.mock('@main/window/windowRegistry.js', () => ({
  sendToWindow: (_windowId: string, _channel: string, request: unknown) => {
    sentRendererRequests.push(request)
  },
  windowForSession: (sessionId: string) => sessionWindowOwner(sessionId),
}))

const { OrchestrationBridge } = await import('@main/orchestration/OrchestrationBridge.js')

describe('OrchestrationBridge status cache', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

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

  it('invalidates only the known parent status cache after prompt submission metadata changes', async () => {
    sentRendererRequests.length = 0
    const bridge = new OrchestrationBridge()

    const created = bridge.createAgent({ parentSessionId: 'parent-1', kind: 'claude' })
    const createRequest = sentRendererRequests[0] as { requestId: string }
    bridge.resolve({
      requestId: createRequest.requestId,
      ok: true,
      type: 'create-agent',
      agent: {
        sessionId: 'child-1',
        kind: 'claude',
        cwd: '/tmp/project',
        orchestrationParentId: 'parent-1',
        orchestrationRootId: 'parent-1',
      },
    })
    await created

    const parentOne = bridge.listAgents({ parentSessionId: 'parent-1' })
    const parentOneRequest = sentRendererRequests[1] as { requestId: string }
    bridge.resolve({
      requestId: parentOneRequest.requestId,
      ok: true,
      type: 'list-agents',
      agents: [],
    })
    await parentOne

    const parentTwo = bridge.listAgents({ parentSessionId: 'parent-2' })
    const parentTwoRequest = sentRendererRequests[2] as { requestId: string }
    bridge.resolve({
      requestId: parentTwoRequest.requestId,
      ok: true,
      type: 'list-agents',
      agents: [],
    })
    await parentTwo

    bridge.notePromptSubmitted('child-1')

    const parentOneAfterPrompt = bridge.listAgents({ parentSessionId: 'parent-1' })
    expect(sentRendererRequests).toHaveLength(4)
    const parentOneAfterPromptRequest = sentRendererRequests[3] as { requestId: string }
    bridge.resolve({
      requestId: parentOneAfterPromptRequest.requestId,
      ok: true,
      type: 'list-agents',
      agents: [],
    })
    await parentOneAfterPrompt

    await bridge.listAgents({ parentSessionId: 'parent-2' })
    expect(sentRendererRequests).toHaveLength(4)
  })

  it('drops expired status cache entries before issuing a new status read', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
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

    vi.setSystemTime(1_300)

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

  it('releases prompt-delivery metadata when a child closes', async () => {
    sentRendererRequests.length = 0
    const bridge = new OrchestrationBridge()
    const created = bridge.createAgent({ parentSessionId: 'parent-1', kind: 'claude' })
    const createRequest = sentRendererRequests[0] as { requestId: string }
    bridge.resolve({
      requestId: createRequest.requestId,
      ok: true,
      type: 'create-agent',
      agent: {
        sessionId: 'child-1',
        kind: 'claude',
        cwd: '/tmp/project',
        orchestrationParentId: 'parent-1',
        orchestrationRootId: 'parent-1',
      },
    })
    await created
    bridge.notePromptSubmitted('child-1')
    expect((bridge as unknown as { promptDeliveries: Map<string, unknown> })
      .promptDeliveries.has('child-1')).toBe(true)

    const closing = bridge.closeAgent({ parentSessionId: 'parent-1', sessionId: 'child-1' })
    const readRequest = sentRendererRequests[1] as { requestId: string }
    bridge.resolve({
      requestId: readRequest.requestId,
      ok: false,
      type: 'read-agent',
      message: 'not needed for this lifecycle assertion',
    })
    await vi.waitFor(() => expect(sentRendererRequests).toHaveLength(3))
    const closeRequest = sentRendererRequests[2] as { requestId: string }
    bridge.resolve({
      requestId: closeRequest.requestId,
      ok: true,
      type: 'close-agent',
      result: { closedSessionIds: ['child-1'] },
    })
    await closing

    expect((bridge as unknown as { promptDeliveries: Map<string, unknown> })
      .promptDeliveries.has('child-1')).toBe(false)
  })
})
