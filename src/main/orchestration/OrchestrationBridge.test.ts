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
 * `sentRendererRequests` is module-global and every test pushes into it, and
 * the bridge dispatches from a queue rather than synchronously — so a request
 * a test leaves queued COULD land after that test reset the array, when its
 * bridge's 30 s dispatch timeout fires mid-way through a later one. The #1101
 * reviewer instrumented the mock and could not reproduce it today: every push
 * was attributed to its owning test across 15 shuffled runs, because no test
 * in this file currently ends with a queued request. So this is a guard
 * against a reachable shape, not a fix for a live leak — the claim that it had
 * already made a mutation look dead was wrong, and the leak that did was in a
 * different file.
 *
 * Counting by parent is worth it anyway: it makes an assertion about "how many
 * reads did THIS poll produce" mean that, rather than "how many requests exist
 * in this file's shared array right now". The older tests below still index
 * the shared array positionally; they are correct because each drives exactly
 * one bridge to completion, and converting them would be churn without a
 * behaviour change.
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

  it('does not let a mutation-invalidated in-flight read be joined or published (#925 guard)', () => {
    // NOT a regression test, unlike the two above it: this one PASSES on main,
    // because on main an in-flight read is pruned after 250 ms and there is
    // nothing left to republish. It guards the code #925 introduces — the
    // conditional republish — and it is the only thing that kills an
    // unconditional one. Labelled a guard so nobody reads it as evidence that
    // the bug reproduced here (#1101 review).
    //
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

  it('drops a FAILED read from the cache so the next poll retries (#1101 review)', async () => {
    // The `.catch` delete is now the ONLY thing that can remove a pending
    // entry, because prune skips `expiresAt === null` by design. Four
    // mutations of it survived the whole suite, and one of them is not even
    // transient: with the delete removed, a single renderer error poisons that
    // key until the app restarts — `list_agents` and `wait_agents` return the
    // same dead error forever, where before this PR prune healed it in 250 ms.
    vi.useFakeTimers()
    sentRendererRequests.length = 0
    const bridge = new OrchestrationBridge()

    const failing = bridge.listAgents({ parentSessionId: 'parent-fail', runId: 'run-a' })
    const request = requestsFor('parent-fail')[0]!
    bridge.resolve({
      requestId: request.requestId,
      ok: false,
      type: 'list-agents',
      message: 'transient renderer error',
    } as never)
    await expect(failing).rejects.toThrow('transient renderer error')

    // THE assertion: the next poll goes to the renderer again. A retained
    // rejected entry would be joined instead, and every later caller would get
    // that same error without a request ever being sent.
    void bridge.listAgents({ parentSessionId: 'parent-fail', runId: 'run-a' })
    await vi.advanceTimersByTimeAsync(0)
    expect(requestsFor('parent-fail')).toHaveLength(2)
  })

  it('a late rejection does not delete a NEWER generation\'s entry (#1101 review)', async () => {
    // The delete is identity-guarded for this: a read rejecting after a
    // mutation invalidated its key and a second read replaced it must not take
    // the second read's entry with it. Dropping the guard survives the suite,
    // and the damage is silent — the replacement read stays in flight while
    // its dedup handle is gone, so every poll during it enqueues a duplicate.
    vi.useFakeTimers()
    sentRendererRequests.length = 0
    const bridge = new OrchestrationBridge()

    const doomed = bridge.listAgents({ parentSessionId: 'parent-gen', runId: 'run-a' })
    const first = requestsFor('parent-gen')[0]!

    // A mutation invalidates the key, then a second read claims it.
    bridge.notePromptSubmitted('child-of-parent-gen')
    const replacement = bridge.listAgents({ parentSessionId: 'parent-gen', runId: 'run-a' })
    await vi.advanceTimersByTimeAsync(0)

    // Now the FIRST read fails, after the second already owns the entry.
    bridge.resolve({
      requestId: first.requestId,
      ok: false,
      type: 'list-agents',
      message: 'renderer went away',
    } as never)
    await expect(doomed).rejects.toThrow('renderer went away')

    // The replacement's entry survived: a third poll joins it rather than
    // enqueueing behind it.
    const sentBefore = requestsFor('parent-gen').length
    const joined = bridge.listAgents({ parentSessionId: 'parent-gen', runId: 'run-a' })
    await vi.advanceTimersByTimeAsync(0)
    expect(requestsFor('parent-gen')).toHaveLength(sentBefore)

    const second = requestsFor('parent-gen').at(-1)!
    bridge.resolve({ requestId: second.requestId, ok: true, type: 'list-agents', agents: [] } as never)
    await vi.advanceTimersByTimeAsync(0)
    await expect(replacement).resolves.toEqual([])
    await expect(joined).resolves.toEqual([])
  })

  it('joins an in-flight read-run-outputs the same way (#1101 review)', async () => {
    // The readRunOutputs half of the fix had no test at all: its pending
    // expiry, its join condition and its prune guard could each be reverted
    // with the suite still green. It is also the read that matters most — it
    // carries transcript slices, it is the most expensive renderer round trip,
    // and `wait_agents` issues one at the end of EVERY wait, so a duplicate
    // costs more here than on list-agents.
    vi.useFakeTimers()
    sentRendererRequests.length = 0
    const bridge = new OrchestrationBridge()

    const first = bridge.readRunOutputs({ parentSessionId: 'parent-out', runId: 'run-a' })
    await vi.advanceTimersByTimeAsync(1_000)
    const second = bridge.readRunOutputs({ parentSessionId: 'parent-out', runId: 'run-a' })
    await vi.advanceTimersByTimeAsync(1_000)

    expect(requestsFor('parent-out')).toHaveLength(1)
    const request = requestsFor('parent-out')[0]!
    expect(request.type).toBe('read-run-outputs')

    bridge.resolve({ requestId: request.requestId, ok: true, type: 'read-run-outputs', outputs: [] } as never)
    await vi.advanceTimersByTimeAsync(0)

    // Nothing was queued behind it, and both callers got the one answer.
    expect(requestsFor('parent-out')).toHaveLength(1)
    await expect(first).resolves.toEqual([])
    await expect(second).resolves.toEqual([])
  })

  it('drops a FAILED read-run-outputs too, and only its own generation (#1101 review)', async () => {
    // The same two mutations survive independently on this cache. They are not
    // covered by the list-agents pair: the two `.catch` blocks are separate
    // code, and this is the expensive read, so a poisoned key here costs more.
    vi.useFakeTimers()
    sentRendererRequests.length = 0
    const bridge = new OrchestrationBridge()

    const failing = bridge.readRunOutputs({ parentSessionId: 'parent-out-fail' })
    const first = requestsFor('parent-out-fail')[0]!
    bridge.resolve({
      requestId: first.requestId,
      ok: false,
      type: 'read-run-outputs',
      message: 'transcript read failed',
    } as never)
    await expect(failing).rejects.toThrow('transcript read failed')

    // Retried rather than joined to the rejection.
    const retry = bridge.readRunOutputs({ parentSessionId: 'parent-out-fail' })
    await vi.advanceTimersByTimeAsync(0)
    expect(requestsFor('parent-out-fail')).toHaveLength(2)

    bridge.resolve({
      requestId: requestsFor('parent-out-fail')[1]!.requestId,
      ok: true,
      type: 'read-run-outputs',
      outputs: [],
    } as never)
    await expect(retry).resolves.toEqual([])
  })

  it('a late read-run-outputs rejection spares the newer entry (#1101 review)', async () => {
    // The identity guard, on this cache. Same ordering as the list-agents
    // case: a read that rejects AFTER a mutation invalidated its key and a
    // second read replaced it must not take the second read's entry with it.
    // Without the guard the replacement stays in flight with no dedup handle,
    // so every poll during it enqueues a duplicate of the most expensive read
    // the bridge makes.
    vi.useFakeTimers()
    sentRendererRequests.length = 0
    const bridge = new OrchestrationBridge()

    const doomed = bridge.readRunOutputs({ parentSessionId: 'parent-out-gen' })
    const first = requestsFor('parent-out-gen')[0]!

    bridge.notePromptSubmitted('child-of-parent-out-gen')
    const replacement = bridge.readRunOutputs({ parentSessionId: 'parent-out-gen' })
    await vi.advanceTimersByTimeAsync(0)
    expect(requestsFor('parent-out-gen')).toHaveLength(1)

    // The first read fails only now, after the second already owns the entry.
    bridge.resolve({
      requestId: first.requestId,
      ok: false,
      type: 'read-run-outputs',
      message: 'renderer went away',
    } as never)
    await expect(doomed).rejects.toThrow('renderer went away')
    await vi.advanceTimersByTimeAsync(0)

    // The replacement's entry survived: a third poll joins it.
    const sentBefore = requestsFor('parent-out-gen').length
    const joined = bridge.readRunOutputs({ parentSessionId: 'parent-out-gen' })
    await vi.advanceTimersByTimeAsync(0)
    expect(requestsFor('parent-out-gen')).toHaveLength(sentBefore)

    bridge.resolve({
      requestId: requestsFor('parent-out-gen').at(-1)!.requestId,
      ok: true,
      type: 'read-run-outputs',
      outputs: [],
    } as never)
    await vi.advanceTimersByTimeAsync(0)
    await expect(replacement).resolves.toEqual([])
    await expect(joined).resolves.toEqual([])
  })

  it('keeps reads with different caps on different keys (#1101 review)', async () => {
    // The key's own comment says it: two reads that differ only in char caps
    // and share a key make one caller silently receive the other's
    // differently-truncated payload — a big read served a tiny excerpt, or the
    // reverse. Nothing tested it, and this PR is what makes settled values
    // actually get published, so a collision now has far more chances to fire.
    vi.useFakeTimers()
    sentRendererRequests.length = 0
    const bridge = new OrchestrationBridge()

    void bridge.readRunOutputs({ parentSessionId: 'parent-caps', maxCharsPerMessage: 500 })
    void bridge.readRunOutputs({ parentSessionId: 'parent-caps', maxCharsPerMessage: 4_000 })
    void bridge.readRunOutputs({ parentSessionId: 'parent-caps', maxCharsPerAgent: 10_000 })
    void bridge.readRunOutputs({ parentSessionId: 'parent-caps', maxMessagesPerAgent: 5 })
    // A repeat of the first cap set joins; a new one does not.
    void bridge.readRunOutputs({ parentSessionId: 'parent-caps', maxCharsPerMessage: 500 })
    await vi.advanceTimersByTimeAsync(0)

    // Only one is SENT (one in-flight slot); the rest are pending cache
    // entries, which is what distinct keying produces.
    const pending = (bridge as unknown as { readRunOutputsCache: Map<string, unknown> }).readRunOutputsCache
    expect(pending.size).toBe(4)
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
  })  // Kept LAST in the file deliberately: this is the one test that ends with
  // requests still queued (nobody answers 500 polls), which is exactly the
  // shape `requestsFor` guards against. Its own assertions are parent-scoped,
  // and its bridge's dispatch timeout is discarded with the fake clock, so
  // nothing it leaves behind can reach another test — but there is no reason
  // to put anything after it.
  it('bounds pending entries by distinct KEY, not by poll count (#925 measurement)', async () => {
    // #925 asks for the pending-key count to be measured rather than a
    // benchmark claimed. "A pending entry is never pruned" is the scariest
    // sentence in the diff, so this is the number that answers it: 500 polls
    // across 20 keys leave 20 entries, not 500. Growth is bounded by how many
    // distinct things are being watched — which is the whole point of the
    // dedup — and every entry leaves on settlement or on failure.
    vi.useFakeTimers()
    sentRendererRequests.length = 0
    const bridge = new OrchestrationBridge()

    const polls: Promise<unknown>[] = []
    for (let round = 0; round < 25; round++) {
      for (let key = 0; key < 20; key++) {
        polls.push(bridge.listAgents({ parentSessionId: 'parent-many', runId: `run-${key}` }).catch(() => null))
      }
      await vi.advanceTimersByTimeAsync(250)
    }

    const cache = (bridge as unknown as { listAgentsCache: Map<string, unknown> }).listAgentsCache
    expect(polls).toHaveLength(500)
    expect(cache.size).toBe(20)
    // And only one of them ever reached the renderer, because the bridge holds
    // exactly one request in flight. The other 19 are queued, not duplicated.
    expect(requestsFor('parent-many')).toHaveLength(1)
  })
})
