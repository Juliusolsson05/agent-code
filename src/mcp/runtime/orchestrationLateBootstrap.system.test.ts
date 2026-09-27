import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// #1370. A healthy provider can take longer than the bridge's 30 s create deadline to start (the
// bundled OpenCode took 43.1 s under CPU contention, #1367 review a). The caller got "outcome
// unknown — do not repeat", the tool handler returned without delivering the prompt, and when the
// renderer finally answered, the child was adopted idle: no brief, and nothing told the parent.
//
// This drives the REAL MCP server, tool handler and OrchestrationBridge over an in-memory
// transport. The true edges are faked: `sendToWindow` (the renderer, which here answers the create
// only when the test says so) and the session manager (no provider process).
// ---------------------------------------------------------------------------

const renderer = {
  requests: [] as Array<Record<string, unknown>>,
  heldCreate: null as null | Record<string, unknown>,
  // Whether a window still owns the parent (the lease the bridge checks).
  parentAttached: true,
  // A replaced pane's id has no window any more (its lease went with it).
  retired: new Set<string>(),
  // The renderer refuses to persist the bootstrap mark.
  failMark: false,
}

vi.mock('@main/window/windowRegistry.js', () => ({
  windowForSession: (sessionId: string) =>
    renderer.retired.has(sessionId) || (!renderer.parentAttached && sessionId === 'parent-1') ? null : 'test-window',
  sendToWindow: (_windowId: string, _channel: string, request: Record<string, unknown>) => {
    renderer.requests.push(request)
    if (request.type === 'create-agent') {
      // The slow provider start: held until the test answers it, after the deadline.
      renderer.heldCreate = request
      return true
    }
    queueMicrotask(() => {
      // The parent's own orchestration_send_prompt path (review of #1375, round 2 b): it reads the
      // child and wakes it before delivering.
      if (request.type === 'read-agent') {
        bridge.resolve({
          requestId: request.requestId as string, ok: true, type: 'read-agent',
          output: { agent: agent(request.sessionId as string), messages: [] },
        } as never)
        return
      }
      if (request.type === 'ensure-agent-live') {
        bridge.resolve({
          requestId: request.requestId as string, ok: true, type: 'ensure-agent-live', agent: agent(request.sessionId as string),
        } as never)
        return
      }
      if (request.type === 'mark-bootstrap-prompt-delivered' && renderer.failMark) {
        bridge.resolve({ requestId: request.requestId as string, ok: false, type: 'mark-bootstrap-prompt-delivered', message: 'workspace store is read-only' } as never)
        return
      }
      if (request.type === 'mark-bootstrap-prompt-delivered') {
        bridge.resolve({
          requestId: request.requestId as string, ok: true, type: 'mark-bootstrap-prompt-delivered',
          agent: agent(request.sessionId as string, true),
        } as never)
        return
      }
      bridge.resolve({ requestId: request.requestId as string, ok: true, type: request.type, agents: [] } as never)
    })
    return true
  },
}))

const { OrchestrationBridge } = await import('@main/orchestration/OrchestrationBridge.js')
const { createBuiltInMcpServer } = await import('@mcp/runtime/createBuiltInMcpServer.js')

let bridge: InstanceType<typeof OrchestrationBridge>

function agent(sessionId: string, bootstrapped = false) {
  return {
    sessionId, kind: 'claude', cwd: '/tmp/project',
    orchestrationParentId: 'parent-1', orchestrationRootId: 'parent-1',
    ...(bootstrapped ? { orchestrationBootstrapPromptDelivered: true } : {}),
  }
}

beforeEach(() => {
  renderer.requests.length = 0
  renderer.heldCreate = null
  renderer.parentAttached = true
  renderer.retired.clear()
  renderer.failMark = false
  bridge = new OrchestrationBridge()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})
afterEach(() => { vi.useRealTimers() })

describe('create_agent whose child starts after the 30 s deadline (#1370)', () => {
  it('delivers the bootstrap prompt to the late child, and tells the caller not to send it again', async () => {
    const deliverPromptToAgent = vi.fn(async () => ({ ok: true }))
    const sessionManager = {
      deliverPromptToAgent,
      canWaitForPromptReadiness: vi.fn(() => true),
      deliverPromptWhenReady: vi.fn(async () => ({ ok: true })),
      getSessionKind: vi.fn(() => 'claude'),
    }
    const server = createBuiltInMcpServer(
      { sessionId: 'parent-1', cwd: '/tmp/project', domains: ['orchestration'] },
      { orchestrationBridge: bridge as never, sessionManager: sessionManager as never },
    )
    const client = new Client({ name: 'late-bootstrap-test', version: '0.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    try {
      await server.connect(serverTransport)
      await client.connect(clientTransport)
      const call = client.callTool({ name: 'orchestration_create_agent', arguments: { kind: 'claude', prompt: 'review the PR' } })
      await vi.waitFor(() => expect(renderer.heldCreate).not.toBeNull())
      await vi.advanceTimersByTimeAsync(30_000)
      const reply = await call
      const text = ((reply.content as Array<{ text: string }>)[0]!).text
      expect(text).toMatch(/UNKNOWN/)
      expect(text).toMatch(/tries to deliver its bootstrap prompt automatically/)
      expect(text).toMatch(/orchestration_read_agent \(promptSubmitted\)/)
      expect(deliverPromptToAgent).not.toHaveBeenCalled()

      // The provider finally starts and the renderer answers.
      bridge.resolve({
        requestId: renderer.heldCreate!.requestId as string, ok: true, type: 'create-agent', agent: agent('child-late'),
      } as never)
      await vi.waitFor(() => expect(deliverPromptToAgent).toHaveBeenCalledTimes(1))
      const [sessionId, prompt] = deliverPromptToAgent.mock.calls[0] as unknown as [string, string]
      expect(sessionId).toBe('child-late')
      expect(prompt).toContain('review the PR')
      // And it is recorded as the child's bootstrap, exactly as a punctual create would record it.
      await vi.waitFor(() => expect(renderer.requests.map(request => request.type)).toContain('mark-bootstrap-prompt-delivered'))
    } finally {
      await client.close()
      await server.close()
    }
  })

  // Review of #1375 (a): a provider with no readiness gate (OpenCode, Grok) answers a warming
  // composer with not-ready. The punctual path hands that failure to the parent to retry; the late
  // path's parent was told delivery is automatic, so the late path retries it itself.
  const notReady = {
    ok: false, stage: 'before-write', code: 'not-ready', message: 'composer is still starting',
    retrySafe: true, disposition: 'retry-same-session', promptWritten: false, enterWritten: false,
  }

  async function lateCreate(
    deliverPromptToAgent: ReturnType<typeof vi.fn>,
    journal?: { recordIncident: ReturnType<typeof vi.fn> },
    options: { readinessGate?: boolean; deliverPromptWhenReady?: ReturnType<typeof vi.fn>; holdAnswer?: boolean } = {},
  ) {
    const sessionManager = {
      deliverPromptToAgent,
      canWaitForPromptReadiness: vi.fn(() => options.readinessGate === true),
      deliverPromptWhenReady: options.deliverPromptWhenReady ?? vi.fn(async () => ({ ok: true })),
      getSessionKind: vi.fn(() => 'opencode'),
    }
    const server = createBuiltInMcpServer(
      { sessionId: 'parent-1', cwd: '/tmp/project', domains: ['orchestration'] },
      { orchestrationBridge: bridge as never, sessionManager: sessionManager as never, ...(journal ? { appRunJournal: journal as never } : {}) },
    )
    const client = new Client({ name: 'late-bootstrap-test', version: '0.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    const call = client.callTool({ name: 'orchestration_create_agent', arguments: { kind: 'opencode', prompt: 'review the PR' } })
    await vi.waitFor(() => expect(renderer.heldCreate).not.toBeNull())
    await vi.advanceTimersByTimeAsync(30_000)
    await call
    const answer = () => bridge.resolve({
      requestId: renderer.heldCreate!.requestId as string, ok: true, type: 'create-agent', agent: agent('child-late'),
    } as never)
    if (!options.holdAnswer) answer()
    return {
      client,
      answer,
      sendPrompt: (prompt: string) => client.callTool({ name: 'orchestration_send_prompt', arguments: { sessionId: 'child-late', prompt } }),
      close: async () => { await client.close(); await server.close() },
    }
  }

  it('retries a late child that is not ready yet until the brief lands', async () => {
    const deliverPromptToAgent = vi.fn()
      .mockResolvedValueOnce(notReady)
      .mockResolvedValueOnce(notReady)
      .mockResolvedValue({ ok: true })
    const run = await lateCreate(deliverPromptToAgent)
    try {
      await vi.waitFor(() => expect(deliverPromptToAgent).toHaveBeenCalledTimes(1))
      await vi.advanceTimersByTimeAsync(2_000)
      await vi.waitFor(() => expect(deliverPromptToAgent).toHaveBeenCalledTimes(2))
      await vi.advanceTimersByTimeAsync(4_000)
      await vi.waitFor(() => expect(deliverPromptToAgent).toHaveBeenCalledTimes(3))
      await vi.waitFor(() => expect(renderer.requests.map(request => request.type)).toContain('mark-bootstrap-prompt-delivered'))
      expect(bridge.promptSubmissionCount('child-late')).toBe(1)
    } finally {
      await run.close()
    }
  })

  it('gives up after about a minute and records it', async () => {
    const deliverPromptToAgent = vi.fn(async () => notReady)
    const journal = { recordIncident: vi.fn() }
    const run = await lateCreate(deliverPromptToAgent, journal)
    try {
      await vi.waitFor(() => expect(deliverPromptToAgent).toHaveBeenCalledTimes(1))
      // Each wait is pinned, not only the total (review of #1375, c: shrinking the last delay to
      // 1 ms survived): an attempt must NOT come early, and must come on time.
      // `settle` drains the delivery's promise chain WITHOUT moving the clock: vi.waitFor would
      // advance fake time while it polls and blur the exact boundaries checked here.
      const settle = async () => { for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(0) }
      await settle()
      const delays = [2_000, 4_000, 8_000, 16_000, 30_000]
      for (const [index, delay] of delays.entries()) {
        await vi.advanceTimersByTimeAsync(delay - 1)
        await settle()
        expect(deliverPromptToAgent).toHaveBeenCalledTimes(index + 1)
        await vi.advanceTimersByTimeAsync(1)
        await settle()
        expect(deliverPromptToAgent).toHaveBeenCalledTimes(index + 2)
      }
      await vi.waitFor(() => expect(journal.recordIncident).toHaveBeenCalledWith(expect.objectContaining({ reason: 'create_agent_late_bootstrap_never_ready' })))
      expect(deliverPromptToAgent).toHaveBeenCalledTimes(6)
      await vi.advanceTimersByTimeAsync(120_000)
      expect(deliverPromptToAgent).toHaveBeenCalledTimes(6)
    } finally {
      await run.close()
    }
  })

  // Through the parent's REAL orchestration_send_prompt, not the bookkeeping call it makes (review
  // of #1375, round 2 b: removing that call from send_prompt survived the old version of this test).
  it('stops retrying once the parent sends the brief itself during a retry delay', async () => {
    const deliverPromptToAgent = vi.fn()
      .mockResolvedValueOnce(notReady)
      .mockResolvedValue({ ok: true })
    const run = await lateCreate(deliverPromptToAgent)
    try {
      await vi.waitFor(() => expect(deliverPromptToAgent).toHaveBeenCalledTimes(1))
      await run.sendPrompt('review the PR, sent by hand')
      expect(deliverPromptToAgent).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(deliverPromptToAgent).toHaveBeenCalledTimes(2)
      expect(bridge.promptSubmissionCount('child-late')).toBe(1)
    } finally {
      await run.close()
    }
  })

  // Review of #1375, round 2 c: the renderer files the child before its create answer reaches main,
  // so the parent can send to it first. Adoption used to reset the child's record to zero and the
  // late bootstrap then sent a second brief.
  it('sends no second brief when the parent sent one before the late answer arrived', async () => {
    const deliverPromptToAgent = vi.fn(async () => ({ ok: true }))
    const run = await lateCreate(deliverPromptToAgent, undefined, { holdAnswer: true })
    try {
      await run.sendPrompt('review the PR, sent by hand')
      expect(deliverPromptToAgent).toHaveBeenCalledTimes(1)
      run.answer()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(deliverPromptToAgent).toHaveBeenCalledTimes(1)
      expect(bridge.promptSubmissionCount('child-late')).toBe(1)
    } finally {
      await run.close()
    }
  })

  // Review of #1375, round 2 c: a collision with another delivery (the parent's send holding the
  // reservation) ended the late loop, though that other delivery could itself fail.
  it('keeps retrying after a reservation collision', async () => {
    const collision = {
      ok: false, stage: 'reservation', code: 'delivery-in-flight', message: 'another delivery is in flight',
      retrySafe: true, disposition: 'retry-same-session', promptWritten: false, enterWritten: false,
    }
    const deliverPromptToAgent = vi.fn()
      .mockResolvedValueOnce(collision)
      .mockResolvedValue({ ok: true })
    const run = await lateCreate(deliverPromptToAgent)
    try {
      await vi.waitFor(() => expect(deliverPromptToAgent).toHaveBeenCalledTimes(1))
      await vi.advanceTimersByTimeAsync(2_000)
      await vi.waitFor(() => expect(deliverPromptToAgent).toHaveBeenCalledTimes(2))
      expect(bridge.promptSubmissionCount('child-late')).toBe(1)
    } finally {
      await run.close()
    }
  })

  // Review of #1375, round 2 a and b: on a provider WITH a readiness gate the late attempt arms a
  // waiter, which can deliver long after. It must be armed with the parent check, so a parent that
  // closes in the meantime stops it at the moment of delivery.
  it('arms a late readiness waiter that re-checks the parent before delivering', async () => {
    let armed: { shouldDeliver?: () => boolean } | undefined
    const deliverPromptWhenReady = vi.fn((_id: string, _prompt: string, _record: unknown, opts?: { shouldDeliver?: () => boolean }) => {
      armed = opts
      return new Promise(() => {})
    })
    const deliverPromptToAgent = vi.fn(async () => notReady)
    const run = await lateCreate(deliverPromptToAgent, undefined, { readinessGate: true, deliverPromptWhenReady })
    try {
      await vi.waitFor(() => expect(deliverPromptWhenReady).toHaveBeenCalledTimes(1))
      expect(armed?.shouldDeliver?.()).toBe(true)
      renderer.parentAttached = false
      expect(armed?.shouldDeliver?.()).toBe(false)
    } finally {
      await run.close()
    }
  })

  // Review of #1375 (b): the parent was checked once, at adoption. A parent that closed during a
  // retry delay still had its brief delivered to the now-ownerless child.
  it('stops retrying when the parent closes during a retry delay', async () => {
    const deliverPromptToAgent = vi.fn(async () => notReady)
    const journal = { recordIncident: vi.fn() }
    const run = await lateCreate(deliverPromptToAgent, journal)
    try {
      await vi.waitFor(() => expect(deliverPromptToAgent).toHaveBeenCalledTimes(1))
      renderer.parentAttached = false
      await vi.advanceTimersByTimeAsync(60_000)
      expect(deliverPromptToAgent).toHaveBeenCalledTimes(1)
      expect(journal.recordIncident).toHaveBeenCalledWith(expect.objectContaining({ reason: 'create_agent_late_bootstrap_parent_gone' }))
    } finally {
      await run.close()
    }
  })

  // q85 / #1369 integration: the parent is REPLACED while the create is still
  // outstanding (a reload during a 43 s start). The late delivery must still
  // reach the child, and its bootstrap mark, which the handler addresses with
  // the retired parent id it captured, must reach the successor's window.
  it('delivers and marks the late bootstrap after the parent was replaced', async () => {
    const deliverPromptToAgent = vi.fn(async () => ({ ok: true }))
    const sessionManager = {
      deliverPromptToAgent,
      canWaitForPromptReadiness: vi.fn(() => true),
      deliverPromptWhenReady: vi.fn(async () => ({ ok: true })),
      getSessionKind: vi.fn(() => 'claude'),
    }
    const server = createBuiltInMcpServer(
      { sessionId: 'parent-1', cwd: '/tmp/project', domains: ['orchestration'] },
      { orchestrationBridge: bridge as never, sessionManager: sessionManager as never },
    )
    const client = new Client({ name: 'late-bootstrap-swap-test', version: '0.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    try {
      await server.connect(serverTransport)
      await client.connect(clientTransport)
      const call = client.callTool({ name: 'orchestration_create_agent', arguments: { kind: 'claude', prompt: 'review the PR' } })
      await vi.waitFor(() => expect(renderer.heldCreate).not.toBeNull())
      await vi.advanceTimersByTimeAsync(30_000)
      await call

      // The parent pane is replaced: the renderer commits it and tells main.
      renderer.retired.add('parent-1')
      bridge.carryParent('parent-1', 'parent-2')
      bridge.resolve({
        requestId: renderer.heldCreate!.requestId as string, ok: true, type: 'create-agent',
        agent: { ...agent('child-late'), orchestrationParentId: 'parent-2', orchestrationRootId: 'parent-2' },
      } as never)
      await vi.waitFor(() => expect(deliverPromptToAgent).toHaveBeenCalledTimes(1))
      await vi.waitFor(() => expect(renderer.requests.map(request => request.type)).toContain('mark-bootstrap-prompt-delivered'))
      const mark = renderer.requests.find(request => request.type === 'mark-bootstrap-prompt-delivered')!
      expect(mark.parentSessionId).toBe('parent-2')
    } finally {
      await client.close()
      await server.close()
    }
  })

  // q85: the late path's persistence warning. A punctual create returns it in
  // the tool reply; a late create's reply is gone (its caller got "outcome
  // unknown"), so the incident journal is its only reader.
  it.each([
    ['late', true],
    ['punctual', false],
  ] as const)('reports a failed bootstrap mark on the %s path', async (_name, late) => {
    renderer.failMark = true
    const recordIncident = vi.fn()
    const deliverPromptToAgent = vi.fn(async () => ({ ok: true }))
    const sessionManager = {
      deliverPromptToAgent,
      canWaitForPromptReadiness: vi.fn(() => true),
      deliverPromptWhenReady: vi.fn(async () => ({ ok: true })),
      getSessionKind: vi.fn(() => 'claude'),
    }
    const server = createBuiltInMcpServer(
      { sessionId: 'parent-1', cwd: '/tmp/project', domains: ['orchestration'] },
      { orchestrationBridge: bridge as never, sessionManager: sessionManager as never, appRunJournal: { recordIncident } as never },
    )
    const client = new Client({ name: 'late-bootstrap-mark-test', version: '0.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    try {
      await server.connect(serverTransport)
      await client.connect(clientTransport)
      const call = client.callTool({ name: 'orchestration_create_agent', arguments: { kind: 'claude', prompt: 'review the PR' } })
      await vi.waitFor(() => expect(renderer.heldCreate).not.toBeNull())
      if (late) await vi.advanceTimersByTimeAsync(30_000)
      const answer = () => bridge.resolve({ requestId: renderer.heldCreate!.requestId as string, ok: true, type: 'create-agent', agent: agent('child-mark') } as never)
      if (!late) answer()
      const text = ((await call).content as Array<{ text: string }>)[0]!.text
      if (late) answer()
      await vi.waitFor(() => expect(renderer.requests.map(request => request.type)).toContain('mark-bootstrap-prompt-delivered'))
      const marked = () => recordIncident.mock.calls.map(([incident]) => incident as { kind: string; context: Record<string, unknown> })
        .filter(incident => incident.kind === 'orchestration.bootstrap_mark_failed')
      if (late) {
        await vi.waitFor(() => expect(marked()).toHaveLength(1))
        expect(marked()[0]!.context).toMatchObject({ sessionId: 'child-mark', message: 'workspace store is read-only' })
      } else {
        // The caller reads the warning; no duplicate incident.
        expect(text).toContain('workspace store is read-only')
        await vi.advanceTimersByTimeAsync(0)
        expect(marked()).toHaveLength(0)
      }
    } finally {
      await client.close()
      await server.close()
    }
  })
})
