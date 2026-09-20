import { afterEach, describe, expect, it, vi } from 'vitest'

const sentRendererRequests: unknown[] = []

// `windowForSession` decides whether the request is deliverable at all; these
// tests are about caching and lifecycle, so every parent session resolves.
// The unowned-parent rejection is asserted separately below.
const sessionWindowOwner = vi.fn((_sessionId: string): string | null => 'test-window')

vi.mock('@main/window/windowRegistry.js', () => ({
  sendToWindow: (_windowId: string, _channel: string, request: unknown) => {
    sentRendererRequests.push(request)
    return true
  },
  windowForSession: (sessionId: string) => sessionWindowOwner(sessionId),
}))

const { OrchestrationBridge } = await import('@main/orchestration/OrchestrationBridge.js')

/**
 * Requests for ONE parent session.
 *
 * `sentRendererRequests` is module-global and every test pushes into it — and
 * the bridge dispatches from a queue, so a request another test enqueued can
 * land after that test reset the array. Counting by parent is what makes an
 * assertion about "how many reads did THIS poll produce" mean that, rather
 * than "how many requests exist in this file's shared array right now". A
 * cross-test leak made a mutation look dead once already.
 */
function requestsFor(parentSessionId: string): Array<{ requestId: string; type: string }> {
  return sentRendererRequests.filter(
    (request): request is { requestId: string; type: string; parentSessionId: string } =>
      (request as { parentSessionId?: string }).parentSessionId === parentSessionId,
  )
}

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

  it('keeps joining a read that is still IN FLIGHT past the freshness window (#925)', async () => {
    // The defect: `expiresAt` was set when the request was CREATED, so a read
    // still waiting on the renderer was "expired" 250 ms later and pruned —
    // and the next identical poll enqueued a DUPLICATE.
    //
    // That is not a rare case. The bridge serialises every orchestration
    // request behind ONE in-flight slot with no timer on the queue, and
    // `wait_agents` polls this key every 250 ms–1 s by design. So a read that
    // queues behind other traffic collects one duplicate per poll, each of
    // which queues behind the last: the cache built to prevent a thundering
    // herd produced one.
    //
    // In-flight dedup must last until SETTLEMENT; freshness starts there.
    vi.useFakeTimers()
    sentRendererRequests.length = 0
    const bridge = new OrchestrationBridge()

    const first = bridge.listAgents({ parentSessionId: 'parent-slow', runId: 'run-a' })
    // Four polling intervals with no answer from the renderer.
    await vi.advanceTimersByTimeAsync(1_000)
    const second = bridge.listAgents({ parentSessionId: 'parent-slow', runId: 'run-a' })
    await vi.advanceTimersByTimeAsync(1_000)
    const third = bridge.listAgents({ parentSessionId: 'parent-slow', runId: 'run-a' })

    // Only one was SENT either way — `MAX_ACTIVE_RENDERER_REQUESTS = 1` means
    // the duplicates queue rather than fly, which is exactly why the defect is
    // invisible until the first read settles and the queue drains into them.
    expect(requestsFor('parent-slow')).toHaveLength(1)

    const request = requestsFor('parent-slow')[0]!
    bridge.resolve({ requestId: request.requestId, ok: true, type: 'list-agents', agents: [] } as never)
    await vi.advanceTimersByTimeAsync(0)

    // THE assertion: the queue had nothing else in it. With the bug, the
    // duplicates dispatch here — and nobody ever answers them, so the joined
    // callers hang on a renderer round trip that should never have existed.
    expect(requestsFor('parent-slow')).toHaveLength(1)
    await expect(first).resolves.toEqual([])
    await expect(second).resolves.toEqual([])
    await expect(third).resolves.toEqual([])
  })

  it('starts the freshness window at SETTLEMENT, not at request time (#925)', async () => {
    // The other half of the same confusion. A read that took 900 ms to settle
    // used to be stale the instant it arrived — its 250 ms window had expired
    // 650 ms before the value existed — so the very next poll re-read it.
    vi.useFakeTimers()
    sentRendererRequests.length = 0
    const bridge = new OrchestrationBridge()

    const slow = bridge.listAgents({ parentSessionId: 'parent-settle', runId: 'run-a' })
    await vi.advanceTimersByTimeAsync(900)
    const request = requestsFor('parent-settle')[0]!
    bridge.resolve({ requestId: request.requestId, ok: true, type: 'list-agents', agents: [] } as never)
    await slow

    // Inside the window measured FROM the answer: joined, and no second
    // request was created to be drained later.
    await vi.advanceTimersByTimeAsync(100)
    const joined = bridge.listAgents({ parentSessionId: 'parent-settle', runId: 'run-a' })
    await vi.advanceTimersByTimeAsync(0)
    expect(requestsFor('parent-settle')).toHaveLength(1)
    await expect(joined).resolves.toEqual([])

    // Past it: a fresh read, because the value is now genuinely old.
    await vi.advanceTimersByTimeAsync(300)
    void bridge.listAgents({ parentSessionId: 'parent-settle', runId: 'run-a' })
    expect(requestsFor('parent-settle')).toHaveLength(2)
  })

  it('does not let a mutation-invalidated in-flight read be joined or published (#925)', () => {
    // A mutation lands while a read is STILL IN FLIGHT. The read was admitted
    // before it, so its answer describes the world before the change: a later
    // poll must not join it, and — the half that is easy to get wrong — its
    // settlement must not put that answer back into the cache for whoever
    // polls next.
    vi.useFakeTimers()
    sentRendererRequests.length = 0
    const bridge = new OrchestrationBridge()

    const stale = bridge.listAgents({ parentSessionId: 'parent-inv', runId: 'run-a' })
    const readRequest = requestsFor('parent-inv')[0]!

    // The mutation invalidates while the read is unanswered.
    // `notePromptSubmitted` is a real one that does NOT itself queue a
    // renderer round trip, so the read stays the only thing in flight — with
    // an unknown child it takes the conservative global clear, which is the
    // path its own comment argues for.
    bridge.notePromptSubmitted('child-of-parent-inv')

    // Now the read answers. With an unconditional republish, this value —
    // computed before the mutation — becomes the cached answer for everyone
    // who polls in the next 250 ms.
    bridge.resolve({ requestId: readRequest.requestId, ok: true, type: 'list-agents', agents: [] } as never)

    return stale.then(async () => {
      await vi.advanceTimersByTimeAsync(0)
      const before = requestsFor('parent-inv').length
      void bridge.listAgents({ parentSessionId: 'parent-inv', runId: 'run-a' })
      expect(requestsFor('parent-inv').length).toBe(before + 1)
    })
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
