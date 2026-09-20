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

function child(lifecycleState: string) {
  return { sessionId: 'child-1', kind: 'claude', cwd: '/repo', title: 'Child', lifecycleState, messageCount: 0 }
}

async function callWait(
  args: Record<string, unknown>,
  lifecycleState = 'running',
  // Bridge latency is not a detail here: every one of these calls is a round
  // trip that `OrchestrationBridge` serializes behind ONE in-flight slot and
  // bounds at 30 s of its own. A harness with an instant bridge measures a
  // wait that cannot happen, and it is exactly where the first version of the
  // cap leaked — the post-loop read was outside the deadline entirely.
  latency: { listMs?: number; readMs?: number } = {},
) {
  const listAgents = vi.fn(async () => {
    if (latency.listMs) await new Promise(resolve => setTimeout(resolve, latency.listMs))
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
    { timeoutMs: 30_000, capped: false },
    { timeoutMs: 30_001, capped: true },
    { timeoutMs: 100_000, capped: true },
  ])('applies the cap on the right side of the boundary: timeoutMs=$timeoutMs', async ({ timeoutMs, capped }) => {
    // Without a case between the cap and the schema maximum, a predicate like
    // `timeoutMs > 150_000 ? cap : timeoutMs` passes the whole suite — and
    // leaves the 100 s retry FROM THE BUG REPORT ITSELF uncapped. 30_001 is
    // the boundary; 100_000 is the reported call.
    vi.useFakeTimers()
    try {
      const pending = callWait({ timeoutMs, pollIntervalMs: 1_000 })
      await vi.advanceTimersByTimeAsync(timeoutMs)
      const { payload, listAgents } = await pending

      expect(payload.done).toBe(false)
      expect(Object.hasOwn(payload, 'remainingMs')).toBe(capped)
      // Polls prove the WAIT was bounded, not only that a field was set.
      expect(listAgents.mock.calls.length).toBeLessThanOrEqual(32)
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

  it('charges a slow final read to the caller\'s budget instead of losing it', async () => {
    // The sharpest hole the first version had: nothing measured WHEN the reply
    // arrived. The loop was capped and then an unbounded `readRunOutputs` ran
    // after it — 60 s of post-loop work was invisible to every assertion, and
    // that is the exact shape of the bug this tool is supposed to be fixing.
    //
    // The read itself cannot be cancelled from here (the bridge owns its own
    // 30 s bound), so what is asserted is that its cost is ACCOUNTED FOR: the
    // wait stops at the cap, and `remainingMs` is computed from real elapsed
    // time, so the seconds the read spent come out of the caller's budget
    // rather than quietly vanishing from it.
    vi.useFakeTimers()
    try {
      const pending = callWait({ timeoutMs: 600_000, pollIntervalMs: 1_000 }, 'running', { readMs: 20_000 })
      await vi.advanceTimersByTimeAsync(600_000)
      const { payload, elapsedMs } = await pending

      expect(elapsedMs).toBe(50_000)
      expect(payload.remainingMs).toBe(550_000)
      // Still well inside the SDK's 60 s default request timeout, which is the
      // bound that actually decides whether this reply arrives.
      expect(elapsedMs).toBeLessThan(60_000)
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
