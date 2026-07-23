import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedAgentRendererDescriptor } from '@mcp/shared/agentManagementTypes.js'

const sentRendererRequests: unknown[] = []
const resolveProviderTranscriptPath = vi.fn(async () => '/tmp/provider-agent.jsonl')

vi.mock('@main/window/mainWindow.js', () => ({
  sendToMainWindow: (_channel: string, request: unknown) => {
    sentRendererRequests.push(request)
  },
}))

vi.mock('@main/providerSwitch/shared.js', () => ({
  resolveProviderTranscriptPath,
  findCodexRolloutPathsBySessionIds: vi.fn(async () => new Map()),
}))

vi.mock('node:fs/promises', () => ({
  stat: vi.fn(async () => ({ mtimeMs: 9_000 })),
}))

const {
  AgentManagementBridge,
  AgentManagementBridgeError,
} = await import('@main/agentManagement/AgentManagementBridge.js')

function managerFixture() {
  return {
    getBackendSnapshot: vi.fn((sessionId: string) => sessionId === 'agent-1'
      ? { lifecycle: 'live' }
      : null),
    getLastActivityAt: vi.fn(() => 8_000),
    resolveTranscriptFile: vi.fn(async () => null),
    getTranscriptFile: vi.fn(() => null),
  }
}

function rendererDescriptor(): ManagedAgentRendererDescriptor {
  return {
    agent: {
      sessionId: 'agent-1',
      kind: 'claude' as const,
      cwd: '/tmp/project',
      project: { tabId: 'tab-1', title: 'Project', index: 0 },
      placement: 'dispatch' as const,
      backendState: 'hibernated' as const,
      activityState: 'completed' as const,
      transcript: { path: null, availability: 'unavailable' as const },
      processActive: false,
      awaitingAssistant: false,
      requiresUserAction: false,
      isCaller: false,
    },
    providerSessionId: 'provider-agent-1',
    runtimeActivityAt: 7_000,
  }
}

describe('AgentManagementBridge', () => {
  beforeEach(() => {
    sentRendererRequests.length = 0
    resolveProviderTranscriptPath.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('enriches renderer ownership with main-owned backend, path, and activity facts', async () => {
    const manager = managerFixture()
    const bridge = new AgentManagementBridge(manager as never)
    const pending = bridge.listAgents({ callerSessionId: 'caller' })
    const request = sentRendererRequests[0] as { requestId: string; type: string }

    bridge.resolve({
      requestId: request.requestId,
      ok: true,
      type: 'list-agents',
      observedAt: 10_000,
      project: { tabId: 'tab-1', title: 'Project', index: 0 },
      agents: [rendererDescriptor()],
    })

    await expect(pending).resolves.toMatchObject({
      observedAt: 10_000,
      agents: [{
        sessionId: 'agent-1',
        backendState: 'live',
        transcript: {
          path: '/tmp/provider-agent.jsonl',
          availability: 'available',
          lastModifiedAt: 9_000,
        },
        lastActivityAt: 9_000,
        lastActivitySource: 'transcript',
        idleForMs: 1_000,
      }],
    })
    expect(resolveProviderTranscriptPath).toHaveBeenCalledWith({
      kind: 'claude',
      cwd: '/tmp/project',
      providerSessionId: 'provider-agent-1',
    })
  })

  it('serializes renderer requests so workspace reads and mutations cannot race', async () => {
    const bridge = new AgentManagementBridge(managerFixture() as never)
    const list = bridge.listAgents({ callerSessionId: 'caller' })
    const send = bridge.sendPrompt({
      callerSessionId: 'caller',
      sessionId: 'agent-1',
      prompt: 'Status?',
    })
    expect(sentRendererRequests).toHaveLength(1)
    const first = sentRendererRequests[0] as { requestId: string }
    bridge.resolve({
      requestId: first.requestId,
      ok: true,
      type: 'list-agents',
      observedAt: 10_000,
      project: { tabId: 'tab-1', title: 'Project', index: 0 },
      agents: [],
    })
    await list
    await vi.waitFor(() => expect(sentRendererRequests).toHaveLength(2))
    const second = sentRendererRequests[1] as { requestId: string }
    bridge.resolve({
      requestId: second.requestId,
      ok: true,
      type: 'send-prompt',
      sessionId: 'agent-1',
      delivery: { ok: true, acceptance: { kind: 'user', acceptedAt: 10_000 } },
    })
    await expect(send).resolves.toMatchObject({ ok: true })
  })

  it('preserves structured cascade refusal details', async () => {
    const bridge = new AgentManagementBridge(managerFixture() as never)
    const closing = bridge.closeAgent({ callerSessionId: 'caller', sessionId: 'parent' })
    const request = sentRendererRequests[0] as { requestId: string }
    bridge.resolve({
      requestId: request.requestId,
      ok: false,
      type: 'close-agent',
      code: 'close_would_affect_additional_sessions',
      message: 'Closing would cascade.',
      sessionId: 'parent',
      additionalAffectedSessionIds: ['child'],
    })

    await expect(closing).rejects.toMatchObject({
      name: AgentManagementBridgeError.name,
      code: 'close_would_affect_additional_sessions',
      details: {
        sessionId: 'parent',
        additionalAffectedSessionIds: ['child'],
      },
    })
  })

  it('returns a typed no-wake failure when no durable transcript exists', async () => {
    const bridge = new AgentManagementBridge(managerFixture() as never)
    const reading = bridge.readAgent({ callerSessionId: 'caller', sessionId: 'fresh-agent' })
    const request = sentRendererRequests[0] as { requestId: string }
    const descriptor = rendererDescriptor()
    descriptor.agent.sessionId = 'fresh-agent'
    delete descriptor.providerSessionId
    bridge.resolve({
      requestId: request.requestId,
      ok: true,
      type: 'read-agent',
      observedAt: 10_000,
      output: {
        output: { agent: descriptor.agent, messages: [] },
      },
    })

    await expect(reading).rejects.toMatchObject({
      code: 'transcript_unavailable',
      details: { sessionId: 'fresh-agent' },
    })
  })

  it('returns an honest empty transcript for a live agent that has not spoken yet', async () => {
    const bridge = new AgentManagementBridge(managerFixture() as never)
    const reading = bridge.readAgent({ callerSessionId: 'caller', sessionId: 'agent-1' })
    const request = sentRendererRequests[0] as { requestId: string }
    const descriptor = rendererDescriptor()
    delete descriptor.providerSessionId
    bridge.resolve({
      requestId: request.requestId,
      ok: true,
      type: 'read-agent',
      observedAt: 10_000,
      output: {
        output: { agent: descriptor.agent, messages: [] },
      },
    })

    await expect(reading).resolves.toMatchObject({
      agent: { sessionId: 'agent-1', backendState: 'live' },
      messages: [],
    })
  })

  it('keeps unavailable bulk histories as explicit census rows', async () => {
    const bridge = new AgentManagementBridge(managerFixture() as never)
    const reading = bridge.readAgents({ callerSessionId: 'caller' })
    const request = sentRendererRequests[0] as { requestId: string }
    const descriptor = rendererDescriptor()
    descriptor.agent.sessionId = 'fresh-agent'
    delete descriptor.providerSessionId
    bridge.resolve({
      requestId: request.requestId,
      ok: true,
      type: 'read-agents',
      observedAt: 10_000,
      project: descriptor.agent.project,
      agents: [descriptor],
      outputs: [{ output: { agent: descriptor.agent, messages: [] } }],
      unavailable: [],
      truncated: false,
      totalChars: 0,
    })

    await expect(reading).resolves.toMatchObject({
      agents: [{ sessionId: 'fresh-agent' }],
      outputs: [{ agent: { sessionId: 'fresh-agent' }, messages: [] }],
      unavailable: [{ sessionId: 'fresh-agent', reason: 'not_created' }],
    })
  })

  it('preserves renderer hydration failures without mislabeling budget-starved rows', async () => {
    const bridge = new AgentManagementBridge(managerFixture() as never)
    const reading = bridge.readAgents({ callerSessionId: 'caller' })
    const request = sentRendererRequests[0] as { requestId: string }
    const unavailableDescriptor = rendererDescriptor()
    unavailableDescriptor.agent.sessionId = 'unavailable-agent'
    const starvedDescriptor = rendererDescriptor()
    starvedDescriptor.agent.sessionId = 'starved-agent'
    starvedDescriptor.agent.kind = 'opencode'
    delete starvedDescriptor.providerSessionId
    bridge.resolve({
      requestId: request.requestId,
      ok: true,
      type: 'read-agents',
      observedAt: 10_000,
      project: unavailableDescriptor.agent.project,
      agents: [unavailableDescriptor, starvedDescriptor],
      outputs: [
        { output: { agent: unavailableDescriptor.agent, messages: [] } },
        { output: { agent: starvedDescriptor.agent, messages: [], truncated: true } },
      ],
      unavailable: [{
        sessionId: 'unavailable-agent',
        reason: 'transcript_unavailable',
      }],
      truncated: true,
      totalChars: 0,
    })

    await expect(reading).resolves.toMatchObject({
      unavailable: [{
        sessionId: 'unavailable-agent',
        reason: 'transcript_unavailable',
      }],
    })
  })

  it('holds serialization after timeout until the renderer acknowledges completion', async () => {
    vi.useFakeTimers()
    const bridge = new AgentManagementBridge(managerFixture() as never)
    const listing = bridge.listAgents({ callerSessionId: 'caller' })
    const request = sentRendererRequests[0] as { requestId: string }
    const closing = bridge.closeAgent({ callerSessionId: 'caller', sessionId: 'agent-1' })
    const rejected = expect(listing).rejects.toThrow('timed out')
    const blocked = expect(closing).rejects.toMatchObject({ code: 'renderer_unresponsive' })

    await vi.advanceTimersByTimeAsync(30_000)
    await Promise.all([rejected, blocked])
    expect(sentRendererRequests).toHaveLength(1)
    expect((bridge as unknown as { pending: Map<string, unknown> }).pending.size).toBe(1)

    bridge.resolve({
      requestId: request.requestId,
      ok: true,
      type: 'list-agents',
      observedAt: 10_000,
      project: { tabId: 'tab-1', title: 'Project', index: 0 },
      agents: [],
    })
    expect((bridge as unknown as { pending: Map<string, unknown> }).pending.size).toBe(0)

    const recovered = bridge.listAgents({ callerSessionId: 'caller' })
    expect(sentRendererRequests).toHaveLength(2)
    const recoveredRequest = sentRendererRequests[1] as { requestId: string }
    bridge.resolve({
      requestId: recoveredRequest.requestId,
      ok: true,
      type: 'list-agents',
      observedAt: 10_000,
      project: { tabId: 'tab-1', title: 'Project', index: 0 },
      agents: [],
    })
    await expect(recovered).resolves.toMatchObject({ agents: [] })
  })

  it('allows bounded cold fleet hydration longer than single-agent operations', async () => {
    vi.useFakeTimers()
    const bridge = new AgentManagementBridge(managerFixture() as never)
    const reading = bridge.readAgents({ callerSessionId: 'caller' })
    let settled = false
    void reading.finally(() => { settled = true })
    const request = sentRendererRequests[0] as { requestId: string }

    await vi.advanceTimersByTimeAsync(30_000)
    expect(settled).toBe(false)
    bridge.resolve({
      requestId: request.requestId,
      ok: true,
      type: 'read-agents',
      observedAt: 10_000,
      project: { tabId: 'tab-1', title: 'Project', index: 0 },
      agents: [],
      outputs: [],
      unavailable: [],
      truncated: false,
      totalChars: 0,
    })
    await expect(reading).resolves.toMatchObject({ agents: [] })
  })

  it('marks a dispatched prompt timeout as retry-unsafe uncertainty', async () => {
    vi.useFakeTimers()
    const bridge = new AgentManagementBridge(managerFixture() as never)
    const sending = bridge.sendPrompt({
      callerSessionId: 'caller',
      sessionId: 'agent-1',
      prompt: 'Do the work once',
    })
    const request = sentRendererRequests[0] as { requestId: string }
    const rejected = expect(sending).rejects.toMatchObject({
      code: 'prompt_delivery_uncertain',
      details: {
        sessionId: 'agent-1',
        retrySafe: false,
        disposition: 'outcome-unknown',
        promptSubmission: 'uncertain',
      },
    })

    await vi.advanceTimersByTimeAsync(30_000)
    await rejected
    bridge.resolve({
      requestId: request.requestId,
      ok: true,
      type: 'send-prompt',
      sessionId: 'agent-1',
      delivery: { ok: true, acceptance: { kind: 'user', acceptedAt: 10_000 } },
    })
  })
})
