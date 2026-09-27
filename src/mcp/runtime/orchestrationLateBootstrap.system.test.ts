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
}

vi.mock('@main/window/windowRegistry.js', () => ({
  windowForSession: () => 'test-window',
  sendToWindow: (_windowId: string, _channel: string, request: Record<string, unknown>) => {
    renderer.requests.push(request)
    if (request.type === 'create-agent') {
      // The slow provider start: held until the test answers it, after the deadline.
      renderer.heldCreate = request
      return true
    }
    queueMicrotask(() => {
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
      expect(text).toMatch(/delivers its bootstrap prompt to it automatically/)
      expect(text).toMatch(/Check orchestration_read_agent for promptSubmitted/)
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

  async function lateCreate(deliverPromptToAgent: ReturnType<typeof vi.fn>, journal?: { recordIncident: ReturnType<typeof vi.fn> }) {
    const sessionManager = {
      deliverPromptToAgent,
      canWaitForPromptReadiness: vi.fn(() => false),
      deliverPromptWhenReady: vi.fn(async () => ({ ok: true })),
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
    bridge.resolve({
      requestId: renderer.heldCreate!.requestId as string, ok: true, type: 'create-agent', agent: agent('child-late'),
    } as never)
    return { close: async () => { await client.close(); await server.close() } }
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
      for (const delay of [2_000, 4_000, 8_000, 16_000, 30_000]) await vi.advanceTimersByTimeAsync(delay)
      await vi.waitFor(() => expect(journal.recordIncident).toHaveBeenCalledWith(expect.objectContaining({ reason: 'create_agent_late_bootstrap_never_ready' })))
      expect(deliverPromptToAgent).toHaveBeenCalledTimes(6)
      await vi.advanceTimersByTimeAsync(120_000)
      expect(deliverPromptToAgent).toHaveBeenCalledTimes(6)
    } finally {
      await run.close()
    }
  })

  it('stops retrying once a prompt has landed on the child some other way', async () => {
    const deliverPromptToAgent = vi.fn(async () => notReady)
    const run = await lateCreate(deliverPromptToAgent)
    try {
      await vi.waitFor(() => expect(deliverPromptToAgent).toHaveBeenCalledTimes(1))
      // The parent checked orchestration_read_agent and sent the brief itself.
      bridge.notePromptSubmitted('child-late')
      await vi.advanceTimersByTimeAsync(60_000)
      expect(deliverPromptToAgent).toHaveBeenCalledTimes(1)
    } finally {
      await run.close()
    }
  })
})
