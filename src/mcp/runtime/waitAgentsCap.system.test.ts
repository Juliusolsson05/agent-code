import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, vi } from 'vitest'

import { createBuiltInMcpServer } from '@mcp/runtime/createBuiltInMcpServer.js'

// #827. A Claude session waited on a two-child run with a generous timeout,
// the transport dropped mid-call, and the tool's response was LOST. The
// children were unaffected; a retry with 100 s returned normally. So any
// orchestration flow that waits long enough silently loses its wait result and
// falls back to polling `orchestration_list_agents` — a reliability failure in
// a first-party MCP surface, caused by us and not by the caller.
//
// The response already carried `done`, so the shape for polling existed. What
// was missing was a server-side bound that keeps the reply inside the window
// the caller can still receive it in.
//
// The ERROR TEXT quoted in #827 is a paraphrase, and the "120 s backgrounding
// threshold" the first version of this suite was written against does not
// exist in the vendored harness source. The bound these tests hold the tool to
// is the one that is real and checkable: the MCP SDK's own
// `DEFAULT_REQUEST_TIMEOUT_MSEC = 60000`, which every client that does not
// override it applies. See WAIT_AGENTS_MAX_WAIT_MS for the full accounting.

function child(lifecycleState: string, sessionId = 'child-1') {
  return { sessionId, kind: 'claude', cwd: '/repo', title: 'Child', lifecycleState, messageCount: 0 }
}

async function callWait(
  args: Record<string, unknown>,
  lifecycleState = 'running',
  // Bridge latency is not a detail here: every one of these calls is a round
  // trip that `OrchestrationBridge` serializes behind ONE in-flight slot and
  // bounds at 30 s of its own. A harness with an instant bridge measures a
  // wait that cannot happen, and it is exactly where the first version of the
  // cap leaked — the post-loop read was outside the deadline entirely.
  // `listMs` may be a per-call list: a bridge that is fast and then stalls is
  // the case that separates "the deadline is checked between polls" from "the
  // deadline is raced against the poll", and a constant latency cannot express
  // it. The last entry repeats.
  latency: { listMs?: number | number[]; readMs?: number } = {},
) {
  let listCall = 0
  const listAgents = vi.fn(async () => {
    const schedule = latency.listMs
    const delay = Array.isArray(schedule)
      ? schedule[Math.min(listCall, schedule.length - 1)] ?? 0
      : schedule ?? 0
    listCall += 1
    if (delay) await new Promise(resolve => setTimeout(resolve, delay))
    return [child(lifecycleState)]
  })
  const readRunOutputs = vi.fn(async () => {
    if (latency.readMs) await new Promise(resolve => setTimeout(resolve, latency.readMs))
    return []
  })
  const server = createBuiltInMcpServer(
    { sessionId: 'parent', cwd: '/repo', domains: ['orchestration'] },
    {
      orchestrationBridge: {
        listAgents,
        readRunOutputs,
      } as never,
    },
  )
  const client = new Client({ name: 'wait-cap-test', version: '0.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  try {
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    const startedAt = Date.now()
    // The CLIENT's own request timeout is raised out of the way on purpose:
    // this suite is about the SERVER bounding its wait, and under fake timers
    // the client's default 60 s would fire first and hide that. (It firing is
    // itself a miniature of the reported bug — a transport that stops
    // listening while the tool is still working.)
    const result = await client.callTool(
      { name: 'orchestration_wait_agents', arguments: args },
      undefined,
      { timeout: 10_000_000 },
    )
    const elapsedMs = Date.now() - startedAt
    const text = (result.content as Array<{ text: string }>)[0]!.text
    return { payload: JSON.parse(text) as Record<string, unknown>, elapsedMs, listAgents, readRunOutputs }
  } finally {
    await client.close()
    await server.close()
  }
}

describe('orchestration_wait_agents stays inside the window its reply can survive (#827)', () => {
  it('caps a long wait and says it capped, so the caller polls instead of losing the reply', async () => {
    vi.useFakeTimers()
    try {
      // The reported call: a generous timeout on children that never settle.
      const pending = callWait({ timeoutMs: 600_000, pollIntervalMs: 1_000 })
      await vi.advanceTimersByTimeAsync(600_000)
      const { payload } = await pending

      // It returned, rather than running the full ten minutes into a transport
      // that is no longer listening.
      expect(payload.done).toBe(false)
      // And it SAYS the wait was shortened, in the form the caller can act on:
      // its own UNSPENT budget, which is what the next call passes as
      // timeoutMs. Reporting the cap instead made the caller reconstruct this
      // from an argument it had to remember.
      expect(payload.remainingMs).toBe(570_000)
      expect(payload).not.toHaveProperty('waitCappedMs')
    } finally {
      vi.useRealTimers()
    }
  })

  it('polls only up to the cap, never for the timeout the caller asked for', async () => {
    vi.useFakeTimers()
    try {
      const pending = callWait({ timeoutMs: 600_000, pollIntervalMs: 1_000 })
      await vi.advanceTimersByTimeAsync(600_000)
      const { listAgents } = await pending

      // One read before the loop, then one per poll inside the cap. Anything
      // near 600 means the cap did not bound the loop.
      expect(listAgents.mock.calls.length).toBeLessThanOrEqual(32)
      expect(listAgents.mock.calls.length).toBeGreaterThan(25)
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves a timeout inside the cap exactly as it was', async () => {
    // The control. "Always return immediately" would satisfy the two above and
    // break every ordinary wait.
    vi.useFakeTimers()
    try {
      const pending = callWait({ timeoutMs: 30_000, pollIntervalMs: 1_000 })
      await vi.advanceTimersByTimeAsync(30_000)
      const { payload, listAgents } = await pending

      expect(payload.done).toBe(false)
      // No cap was applied, so the field is absent rather than reported as 0.
      expect(payload).not.toHaveProperty('remainingMs')
      expect(listAgents.mock.calls.length).toBeGreaterThan(25)
      expect(listAgents.mock.calls.length).toBeLessThanOrEqual(32)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    // Inside the cap: nothing was cut short, so nothing to report.
    { timeoutMs: 30_000, remainingMs: undefined },
    // Cut short, but the remainder is 1 ms — BELOW the schema's own
    // `min(1000)` for timeoutMs. Reporting it walked the documented recovery
    // path ("call this again with remainingMs") straight into an MCP -32602
    // validation error, which is a worse answer than the silence this PR set
    // out to replace. Omitted means what it means everywhere else here: your
    // budget is spent.
    { timeoutMs: 30_001, remainingMs: undefined },
    { timeoutMs: 30_500, remainingMs: undefined },
    // Legal remainder: reported, and it is exactly what the next call passes.
    { timeoutMs: 31_000, remainingMs: 1_000 },
    // The retry from the bug report itself.
    { timeoutMs: 100_000, remainingMs: 70_000 },
  ])('reports a remainder only when it is a legal next timeoutMs: $timeoutMs', async ({ timeoutMs, remainingMs }) => {
    // Without cases between the cap and the schema maximum, a predicate like
    // `timeoutMs > 150_000 ? cap : timeoutMs` passes the whole suite — and
    // leaves the 100 s retry FROM THE BUG REPORT uncapped.
    vi.useFakeTimers()
    try {
      const pending = callWait({ timeoutMs, pollIntervalMs: 1_000 })
      await vi.advanceTimersByTimeAsync(timeoutMs)
      const { payload, listAgents } = await pending

      expect(payload.done).toBe(false)
      expect(payload.remainingMs).toBe(remainingMs)
      // Polls prove the WAIT was bounded, not only that a field was set.
      expect(listAgents.mock.calls.length).toBeLessThanOrEqual(32)
    } finally {
      vi.useRealTimers()
    }
  })

  it('walks its own documented recovery path to the end', async () => {
    // The instruction in the tool description is "call this again with
    // remainingMs". A caller that follows it literally must never be handed a
    // value the schema then rejects — and it was: any starting timeout whose
    // remainder mod the cap fell under a second ended the loop on a -32602.
    vi.useFakeTimers()
    try {
      let timeoutMs = 60_500
      const seen: number[] = []
      for (let call = 0; call < 5; call += 1) {
        const pending = callWait({ timeoutMs, pollIntervalMs: 1_000 })
        await vi.advanceTimersByTimeAsync(timeoutMs)
        const { payload } = await pending
        const next = payload.remainingMs as number | undefined
        if (next === undefined) break
        expect(next).toBeGreaterThanOrEqual(1_000)
        seen.push(next)
        timeoutMs = next
      }
      // 60_500 → 30_500 → (500, illegal) so the chain stops honestly rather
      // than handing over a value that cannot be sent.
      expect(seen).toEqual([30_500])
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    // Capped: 7 s does not divide 30 s, so an unclamped sleep lands at 35 s.
    { timeoutMs: 600_000, pollIntervalMs: 7_000, bound: 30_000 },
    // NOT capped, and the sharper case: the overshoot breaks the caller's OWN
    // timeout. 25 s asked for, 30 s spent, and no cap was even involved.
    { timeoutMs: 25_000, pollIntervalMs: 10_000, bound: 25_000 },
  ])('stops waiting exactly when it said it would: timeoutMs=$timeoutMs poll=$pollIntervalMs', async ({ timeoutMs, pollIntervalMs, bound }) => {
    // The deadline is checked before the sleep, never during it, so an
    // unclamped `sleep(pollIntervalMs)` overshoots by up to a whole interval —
    // measured at 90_010 ms against the first version's 90_000 ms cap. A bound
    // a caller-chosen argument can exceed is not a bound.
    //
    // The intervals are chosen NOT to divide the deadline. An earlier version
    // of this test used 10 s against a 30 s cap, where clamped and unclamped
    // land on the same tick — it passed on the broken code and proved nothing.
    vi.useFakeTimers()
    try {
      // Measured AT RESOLUTION, inside the harness: `advanceTimersByTimeAsync`
      // moves the clock the full span whatever the tool did, so reading the
      // clock afterwards measures the test, not the tool.
      const pending = callWait({ timeoutMs, pollIntervalMs })
      await vi.advanceTimersByTimeAsync(600_000)
      const { elapsedMs } = await pending

      expect(elapsedMs).toBe(bound)
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops the outputs rather than the reply when the final read would run past the cap', async () => {
    // The sharpest hole round 1 left: nothing measured WHEN the reply arrived.
    // The loop was capped and then an unbounded `readRunOutputs` ran after it,
    // so 20 s of post-loop work was invisible to every assertion — the exact
    // shape of the bug this tool exists to prevent.
    //
    // A cut-short wait now returns its agents at the cap and SAYS the outputs
    // are missing, rather than holding the reply open for a read the caller's
    // transport may not still be listening for. The caller can read them with
    // `orchestration_read_run_outputs` on a fresh budget; it cannot recover a
    // reply that was dropped in flight.
    vi.useFakeTimers()
    try {
      const pending = callWait({ timeoutMs: 600_000, pollIntervalMs: 1_000 }, 'running', { readMs: 20_000 })
      await vi.advanceTimersByTimeAsync(600_000)
      const { payload, elapsedMs } = await pending

      expect(elapsedMs).toBe(30_000)
      expect(payload.outputsUnavailable).toBe(true)
      expect(payload.outputs).toEqual([])
      // The agents it DID read are still reported, and so is the remainder.
      expect((payload.agents as unknown[]).length).toBe(1)
      expect(payload.remainingMs).toBe(570_000)
      // Well inside the 60 s floor that decides whether this reply arrives.
      expect(elapsedMs).toBeLessThan(60_000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns the outputs when the run finishes with budget to spare', async () => {
    // The control for the case above. "Always drop the outputs" would satisfy
    // it and gut the tool: the reply that matters most — the run finished — is
    // the one that must carry them.
    vi.useFakeTimers()
    try {
      const pending = callWait({ timeoutMs: 600_000, pollIntervalMs: 1_000 }, 'completed', { readMs: 5_000 })
      await vi.advanceTimersByTimeAsync(600_000)
      const { payload, elapsedMs } = await pending

      expect(payload.done).toBe(true)
      expect(payload).not.toHaveProperty('outputsUnavailable')
      expect(elapsedMs).toBe(5_000)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    // Each row is the measured end of the call, and each is EARLIER than the
    // 30 s cap on purpose: the loop stops once what is left would not cover
    // another round trip plus the final read. The reserve is the measured cost
    // of this call's own bridge reads, not an invented constant, so it grows
    // exactly when the bridge is congested — which is when it matters.
    { listMs: 5_000, elapsed: 20_750 },
    // One round trip costs two thirds of the budget: there is no second poll
    // to be had, so the call does not pretend otherwise.
    { listMs: 20_000, elapsed: 20_000 },
    // The round-2 measurement: this was 58,250 ms before the reads were raced.
    { listMs: 29_000, elapsed: 29_000 },
  ])('bounds a poll whose listAgents takes $listMs ms, not just the sleep between polls', async ({ listMs, elapsed }) => {
    // Round 2's blocking finding, measured: the deadline is checked before the
    // sleep and never during an `await`, so clamping the SLEEP left every
    // in-loop `listAgents` free to run past it. With a bridge under the
    // contention its own comments describe — one in-flight slot for every
    // orchestration request app-wide, no timer on the queue wait — one call
    // was measured at 87,250 ms against a 30 s promise, past the 60 s floor
    // that decides whether the reply arrives at all. #827, reproduced by the
    // fix for #827.
    vi.useFakeTimers()
    try {
      const pending = callWait({ timeoutMs: 600_000, pollIntervalMs: 250 }, 'running', { listMs })
      await vi.advanceTimersByTimeAsync(600_000)
      const { elapsedMs } = await pending

      expect(elapsedMs).toBe(elapsed)
      // The invariant the exact numbers above are instances of.
      expect(elapsedMs).toBeLessThanOrEqual(30_000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('cuts off a poll that stalls AFTER the bridge looked healthy', async () => {
    // The reserve the loop keeps for the final read is the measured cost of
    // this call's own reads, so a bridge that is fast and then stalls gets
    // into the loop with almost no reserve — and that is exactly when
    // contention arrives, since `MAX_ACTIVE_RENDERER_REQUESTS = 1` serializes
    // every orchestration request app-wide behind one slot with no timer on
    // the queue.
    //
    // Three instant polls, then a 45 s stall. Checking the deadline BETWEEN
    // polls cannot help here: the stall happens inside the `await`. Only
    // racing the read against the deadline can, and without the race this
    // returns at 45,750 ms — past the 60 s floor once a slow final read is
    // added, which is the 87 s call round 2 measured.
    vi.useFakeTimers()
    try {
      const pending = callWait({ timeoutMs: 600_000, pollIntervalMs: 250 }, 'running', { listMs: [0, 0, 0, 45_000] })
      await vi.advanceTimersByTimeAsync(600_000)
      const { payload, elapsedMs } = await pending

      expect(elapsedMs).toBe(30_000)
      // And what it reports is what it actually knows: the last good read.
      expect(payload.done).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never reports done when it could not read the agents at all', async () => {
    // The dangerous shape, and the reason an expired read is not just "no
    // agents": `done` is computed over the list, so an EMPTY list reads as
    // "every child finished". A list that was never read must therefore be
    // distinguishable from a list that came back empty — otherwise a call that
    // ran out of time reports exactly the false completion this whole tool is
    // about.
    vi.useFakeTimers()
    try {
      const pending = callWait({ timeoutMs: 600_000, pollIntervalMs: 250 }, 'running', { listMs: 40_000 })
      await vi.advanceTimersByTimeAsync(600_000)
      const { payload, elapsedMs } = await pending

      expect(elapsedMs).toBe(30_000)
      expect(payload.done).toBe(false)
      expect(payload.agentsUnavailable).toBe(true)
      expect(payload.agents).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('starts the clock before the first listAgents, not after it', async () => {
    // That call is a round trip through a bridge that serializes every
    // orchestration request behind one in-flight slot, so its queue wait has
    // no bound. Starting the deadline after it would ADD that wait to the cap
    // rather than spend it inside the cap — which is how a 30 s promise
    // becomes a 60 s call on a busy app.
    vi.useFakeTimers()
    try {
      const pending = callWait({ timeoutMs: 600_000, pollIntervalMs: 1_000 }, 'running', { listMs: 10_000 })
      await vi.advanceTimersByTimeAsync(600_000)
      const { elapsedMs } = await pending

      // The first list costs 10 s of the 30 s cap; it does not extend it.
      expect(elapsedMs).toBeLessThanOrEqual(40_000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the sessionIds scope on every poll, not only the first read', async () => {
    // A `sessionIds` wait is a question about NAMED children. The filter used
    // to be re-applied each iteration and a reviewer's mutation that dropped
    // the in-loop copy survived the whole suite, because no case had a run
    // whose membership CHANGES while the wait is open.
    //
    // It does change: `create_agent` can add a child to the same run at any
    // time. With the scope applied only once, that newcomer joins the set the
    // caller explicitly named, and its activity keeps the wait open long past
    // the children the caller asked about — reported, eventually, as those
    // children's result.
    vi.useFakeTimers()
    try {
      // The named child is still working, so the wait actually polls — the
      // first read alone would never reach the in-loop filter.
      let roster = [child('running', 'asked-about')]
      const listAgents = vi.fn(async () => roster)
      const server = createBuiltInMcpServer(
        { sessionId: 'parent', cwd: '/repo', domains: ['orchestration'] },
        { orchestrationBridge: { listAgents, readRunOutputs: vi.fn(async () => []) } as never },
      )
      const client = new Client({ name: 'wait-scope-test', version: '0.0.0' })
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      try {
        await server.connect(serverTransport)
        await client.connect(clientTransport)
        const startedAt = Date.now()
        // Measured AT RESOLUTION: `advanceTimersByTimeAsync` moves the clock
        // the full span whatever the tool did, so reading it afterwards
        // measures the test rather than the tool. (This is the third time that
        // has caught me in this file; it is why the shared harness does it.)
        let resolvedAt = 0
        const pending = client.callTool(
          { name: 'orchestration_wait_agents', arguments: { timeoutMs: 600_000, pollIntervalMs: 1_000, sessionIds: ['asked-about'] } },
          undefined,
          { timeout: 10_000_000 },
        ).then(result => { resolvedAt = Date.now(); return result })
        // The named child finishes, and a stranger joins the same run at the
        // same moment — exactly what create_agent does while a wait is open.
        await vi.advanceTimersByTimeAsync(2_000)
        roster = [child('completed', 'asked-about'), child('running', 'newcomer')]
        await vi.advanceTimersByTimeAsync(600_000)
        const result = await pending
        const elapsedMs = resolvedAt - startedAt
        const payload = JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as Record<string, unknown>

        // The wait ends when the NAMED child finishes. With the scope applied
        // only to the first read, the newcomer's activity keeps it open to the
        // cap and the caller waits 30 s for an agent it never asked about.
        expect(payload.done).toBe(true)
        expect((payload.agents as Array<{ sessionId: string }>).map(agent => agent.sessionId)).toEqual(['asked-about'])
        expect(elapsedMs).toBeLessThan(4_000)
      } finally {
        await client.close()
        await server.close()
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns at once when the children are already done, whatever the timeout', async () => {
    const { payload, elapsedMs } = await callWait({ timeoutMs: 600_000 }, 'completed')

    expect(payload.done).toBe(true)
    expect(payload).not.toHaveProperty('remainingMs')
    expect(elapsedMs).toBeLessThan(5_000)
  })

  it('tells the caller about the cap in the tool description, not only in the reply', async () => {
    // An agent reads the description before it chooses a timeout. A cap it can
    // only discover by being capped is a cap it will keep being surprised by.
    const server = createBuiltInMcpServer({ sessionId: 'parent', cwd: '/repo', domains: ['orchestration'] })
    const client = new Client({ name: 'wait-cap-doc-test', version: '0.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    try {
      await server.connect(serverTransport)
      await client.connect(clientTransport)
      const tool = (await client.listTools()).tools.find(item => item.name === 'orchestration_wait_agents')
      // The number AND the instruction. `toContain('30')` alone was close to a
      // free assertion — the old description said "90" and a mutant that
      // changed the unit to MINUTES passed it. What an agent needs from this
      // text is the bound, the unit, and what to do when it is hit.
      expect(tool?.description).toContain('30 SECONDS')
      expect(tool?.description).toMatch(/remainingMs/)
      expect(tool?.description).toMatch(/call this again/i)
      // The field description is a separate surface and was argued for
      // separately in this PR: an agent choosing a timeout reads the SCHEMA.
      const timeoutField = (tool?.inputSchema.properties as Record<string, { description?: string }>).timeoutMs
      expect(timeoutField?.description).toContain('30 s')
      expect(timeoutField?.description).toContain('remainingMs')
    } finally {
      await client.close()
      await server.close()
    }
  })
})
