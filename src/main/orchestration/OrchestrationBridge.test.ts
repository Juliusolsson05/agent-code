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

  it('a failed child reads failed until the parent prompts it again, then prompt_sent (#1018)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    sentRendererRequests.length = 0
    const bridge = new OrchestrationBridge()
    const child = { sessionId: 'child-1', kind: 'opencode' as const, cwd: '/tmp/project', orchestrationParentId: 'parent-1', orchestrationRootId: 'parent-1' }
    const listWith = async (agent: Record<string, unknown>) => {
      const listed = bridge.listAgents({ parentSessionId: 'parent-1' })
      const request = sentRendererRequests.at(-1) as { requestId: string }
      bridge.resolve({ requestId: request.requestId, ok: true, type: 'list-agents', agents: [{ ...child, ...agent }] as never })
      return (await listed)[0]!
    }
    vi.setSystemTime(1_000)
    bridge.notePromptSubmitted('child-1')
    // The renderer reports the provider failure produced after that prompt.
    expect(await listWith({ lifecycleState: 'failed', failedAt: 2_000, errorSummary: 'Usage limit reached' }))
      .toMatchObject({ lifecycleState: 'failed', errorSummary: 'Usage limit reached' })
    // The parent retries: until the provider picks the new prompt up, the
    // renderer still carries the old failure, but the child is waiting on
    // the new prompt, not failed.
    vi.setSystemTime(3_000)
    bridge.notePromptSubmitted('child-1')
    expect(await listWith({ lifecycleState: 'failed', failedAt: 2_000, errorSummary: 'Usage limit reached' }))
      .toMatchObject({ lifecycleState: 'prompt_sent' })
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

describe('a duplicate create must not spawn a second child (#952)', () => {
  // On 2026-09-12 one `orchestration_create_agent` call produced TWO children
  // 0.9 s apart — same title, cwd, role and prompt, both bootstrapped, both
  // working in the same worktree and writing the same report. Only one was
  // returned, so the parent could not see or close the other.
  //
  // Nothing in this process retries, and both children were bootstrapped, so
  // two complete tool invocations ran: the duplicate arrived from the MCP
  // client, above anything this codebase controls. These pin the property
  // that makes that harmless.
  const child = (sessionId: string) => ({
    sessionId,
    kind: 'claude' as const,
    cwd: '/tmp/project',
    orchestrationParentId: 'parent-1',
    orchestrationRootId: 'parent-1',
  })

  const createRequests = () =>
    sentRendererRequests.filter(entry => (entry as { type?: string }).type === 'create-agent')

  it('asks the renderer once and returns the same child to both callers', async () => {
    sentRendererRequests.length = 0
    const bridge = new OrchestrationBridge()
    const params = { parentSessionId: 'parent-1', kind: 'claude' as const, title: 'Reviewer', runId: 'run-a' }

    const first = bridge.createAgent(params)
    const second = bridge.createAgent(params)

    // Deliberately NOT asserted before the resolve: the bridge already
    // serialises renderer requests, so "only one sent so far" is true even
    // WITHOUT the dedupe and would pass for the wrong reason. What separates
    // them is what happens after the first settles — an undeduped second
    // would dispatch off the queue and create a real second child.
    const request = createRequests()[0] as { requestId: string }
    bridge.resolve({ requestId: request.requestId, ok: true, type: 'create-agent', agent: child('child-1') })

    expect((await first).sessionId).toBe('child-1')
    expect((await second).sessionId).toBe('child-1')
    expect(createRequests()).toHaveLength(1)
  })

  it('still creates a second child once the first has finished', async () => {
    // The guard is IN-FLIGHT only. A deliberate "spawn another one just like
    // that" is legitimate, and collapsing it would be guessing at something
    // the caller could plausibly mean.
    sentRendererRequests.length = 0
    const bridge = new OrchestrationBridge()
    const params = { parentSessionId: 'parent-1', kind: 'claude' as const, title: 'Reviewer' }

    const first = bridge.createAgent(params)
    bridge.resolve({
      requestId: (createRequests()[0] as { requestId: string }).requestId,
      ok: true, type: 'create-agent', agent: child('child-1'),
    })
    await first

    const second = bridge.createAgent(params)
    await vi.waitFor(() => expect(createRequests()).toHaveLength(2))
    bridge.resolve({
      requestId: (createRequests()[1] as { requestId: string }).requestId,
      ok: true, type: 'create-agent', agent: child('child-2'),
    })
    expect((await second).sessionId).toBe('child-2')
  })

  it('does not collapse creates that describe DIFFERENT children', async () => {
    // Concurrent fan-out is the normal orchestration pattern. Only an
    // identical request is a duplicate.
    sentRendererRequests.length = 0
    const bridge = new OrchestrationBridge()
    const pending = [
      bridge.createAgent({ parentSessionId: 'parent-1', kind: 'claude', title: 'A' }),
      bridge.createAgent({ parentSessionId: 'parent-1', kind: 'claude', title: 'B' }),
      bridge.createAgent({ parentSessionId: 'parent-1', kind: 'codex', title: 'A' }),
      bridge.createAgent({ parentSessionId: 'parent-2', kind: 'claude', title: 'A' }),
    ]

    // One at a time, because the bridge serialises renderer requests: the next
    // is dispatched only once the previous settles.
    const children = ['child-a', 'child-b', 'child-c', 'child-d']
    for (let index = 0; index < children.length; index += 1) {
      await vi.waitFor(() => expect(createRequests()).toHaveLength(index + 1))
      const request = createRequests()[index] as { requestId: string }
      bridge.resolve({ requestId: request.requestId, ok: true, type: 'create-agent', agent: child(children[index]!) })
    }
    expect((await Promise.all(pending)).map(agent => agent.sessionId)).toEqual(children)
    expect(createRequests()).toHaveLength(4)
  })

  it('lets the next identical create through after a failure', async () => {
    // A create that threw left no child behind, so the caller must be able to
    // really create one rather than inherit the earlier error forever.
    sentRendererRequests.length = 0
    const bridge = new OrchestrationBridge()
    const params = { parentSessionId: 'parent-1', kind: 'claude' as const, title: 'Reviewer' }

    const failed = bridge.createAgent(params)
    bridge.resolve({
      requestId: (createRequests()[0] as { requestId: string }).requestId,
      ok: false, type: 'create-agent', message: 'renderer refused',
    } as never)
    await expect(failed).rejects.toThrow(/renderer refused/)

    const retried = bridge.createAgent(params)
    await vi.waitFor(() => expect(createRequests()).toHaveLength(2))
    bridge.resolve({
      requestId: (createRequests()[1] as { requestId: string }).requestId,
      ok: true, type: 'create-agent', agent: child('child-1'),
    })
    expect((await retried).sessionId).toBe('child-1')
  })
})
