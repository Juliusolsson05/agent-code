import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedAgentRendererDescriptor } from '@mcp/shared/agentManagementTypes.js'

vi.mock('@providers/registry.main.js', () => ({ getMainProvider: () => ({}), listMainProviders: () => [] }))

const sentRendererRequests: unknown[] = []
const resolveProviderTranscriptPath = vi.fn(async () => '/tmp/provider-agent.jsonl')

// See the note in OrchestrationBridge.test.ts: routing is stubbed to one
// always-resolvable window so these tests can be about the bridge's own
// serialization and inventory behavior.
const sessionWindowOwner = vi.fn((_sessionId: string): string | null => 'test-window')

vi.mock('@main/window/windowRegistry.js', () => ({
  sendToWindow: (_windowId: string, _channel: string, request: unknown) => {
    sentRendererRequests.push(request)
    return true
  },
  windowForSession: (sessionId: string) => sessionWindowOwner(sessionId),
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
    resolveTranscriptFile: vi.fn(async (_sessionId: string): Promise<string | null> => null),
    getTranscriptFile: vi.fn(() => null),
  }
}

function rendererDescriptor(): ManagedAgentRendererDescriptor {
  return {
    agent: {
      sessionId: 'agent-1',
      displayLabel: 'A2',
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

  it.each([
    // The label has to be the renderer's, not "wherever this number arrived
    // from". Publishing a JSONL watermark as `'runtime'` cites a real
    // transcript record as though it were a clock, and `lastActivitySource` is
    // what an auditing agent quotes back (review of #1080).
    { source: 'transcript' as const, expected: 'transcript' },
    { source: 'runtime' as const, expected: 'runtime' },
    // An older renderer, or one with no evidence at all, sends no source. The
    // number is still the renderer's, so 'runtime' is the honest floor.
    { source: undefined, expected: 'runtime' },
  ])('takes the renderer\'s UNIFIED last-active AND its source ($source)', async ({ source, expected }) => {
    // The bridge used to recombine `transcriptActivityAt` and
    // `runtimeActivityAt` with a rule that differed from the TLDR peek
    // footer's, so the two surfaces could report different "last active" times
    // for the same agent.
    const manager = managerFixture()
    const bridge = new AgentManagementBridge(manager as never)
    const pending = bridge.listAgents({ callerSessionId: 'caller' })
    const request = sentRendererRequests[0] as { requestId: string }

    bridge.resolve({
      requestId: request.requestId,
      ok: true,
      type: 'list-agents',
      observedAt: 10_000,
      project: { tabId: 'tab-1', title: 'Project', index: 0 },
      // The unified answer is NEWER than the transcript's mtime (9_000),
      // which is the whole point: a tool record the old rule refused to count.
      agents: [{
        ...rendererDescriptor(),
        lastActiveAt: 9_500,
        ...(source ? { lastActiveSource: source } : {}),
      }],
    })

    await expect(pending).resolves.toMatchObject({
      agents: [{
        sessionId: 'agent-1',
        lastActivityAt: 9_500,
        lastActivitySource: expected,
        idleForMs: 500,
      }],
    })
  })

  it('still lets the backend clock win when it is the newest, and says so', async () => {
    // `backendActivityAt` is a main-side wall clock the renderer runtime may
    // not have at all (a pane that was never hydrated). Dropping it as a
    // candidate used to leave the whole suite green.
    const manager = managerFixture()
    manager.getLastActivityAt = vi.fn(() => 9_900)
    const bridge = new AgentManagementBridge(manager as never)
    const pending = bridge.listAgents({ callerSessionId: 'caller' })
    const request = sentRendererRequests[0] as { requestId: string }

    bridge.resolve({
      requestId: request.requestId,
      ok: true,
      type: 'list-agents',
      observedAt: 10_000,
      project: { tabId: 'tab-1', title: 'Project', index: 0 },
      agents: [{ ...rendererDescriptor(), lastActiveAt: 9_500, lastActiveSource: 'transcript' }],
    })

    await expect(pending).resolves.toMatchObject({
      agents: [{ sessionId: 'agent-1', lastActivityAt: 9_900, lastActivitySource: 'backend' }],
    })
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
      target: { sessionId: 'agent-1' },
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
      displayLabel: 'A2',
      delivery: { ok: true, acceptance: { kind: 'user', acceptedAt: 10_000 } },
    })
    await expect(send).resolves.toMatchObject({
      sessionId: 'agent-1',
      displayLabel: 'A2',
      delivery: { ok: true },
    })
  })

  it('preserves structured cascade refusal details', async () => {
    const bridge = new AgentManagementBridge(managerFixture() as never)
    // A close now requires an explicit user grant at the mutation boundary.
    // Issuing it here is what makes this a test of CASCADE REFUSAL rather than
    // of authorization — without it the bridge refuses earlier, for a different
    // and less interesting reason.
    const closing = bridge.closeAgent({ callerSessionId: 'caller', target: { sessionId: 'parent' } })
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
    const reading = bridge.readAgent({ callerSessionId: 'caller', target: { sessionId: 'fresh-agent' } })
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
    const reading = bridge.readAgent({ callerSessionId: 'caller', target: { sessionId: 'agent-1' } })
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

  it.each([
    { label: 'read-agent', call: 'readAgent' as const },
    { label: 'read-agents', call: 'readAgents' as const },
  ])('carries the renderer\'s activity answer through the $label path too', async ({ call }) => {
    // `enrichOutput` re-wraps a read result as a descriptor before enriching
    // it. Dropping the activity fields there is invisible from the outside:
    // `enrichDescriptor` just falls back to the transcript mtime and the agent
    // still gets A number, one that is older and cited as the wrong evidence.
    // Both read paths used to be unguarded.
    const bridge = new AgentManagementBridge(managerFixture() as never)
    const reading = call === 'readAgent'
      ? bridge.readAgent({ callerSessionId: 'caller', target: { sessionId: 'agent-1' } })
      : bridge.readAgents({ callerSessionId: 'caller' })
    const request = sentRendererRequests[0] as { requestId: string }
    const descriptor = rendererDescriptor()
    delete descriptor.providerSessionId
    const output = {
      output: { agent: descriptor.agent, messages: [] },
      lastActiveAt: 9_500,
      lastActiveSource: 'transcript' as const,
    }
    bridge.resolve({
      requestId: request.requestId,
      ok: true,
      type: call === 'readAgent' ? 'read-agent' : 'read-agents',
      observedAt: 10_000,
      ...(call === 'readAgent' ? { output } : {
        // `agents` is deliberately EMPTY: when the census already holds the
        // session the bulk path reuses that record and never reaches
        // `enrichOutput`, which is the code under test here.
        project: { tabId: 'tab-1', title: 'Project', index: 0 },
        agents: [],
        outputs: [output],
        unavailable: [],
      }),
    } as never)

    const resolved = await reading
    const agent = call === 'readAgent'
      ? (resolved as { agent: { lastActivityAt?: number; lastActivitySource?: string } }).agent
      : (resolved as { outputs: Array<{ agent: { lastActivityAt?: number; lastActivitySource?: string } }> }).outputs[0]!.agent
    // 9_500 beats the fixture's transcript mtime (9_000) and backend (8_000),
    // so the assertion fails the moment the field stops making the trip.
    expect(agent).toMatchObject({ lastActivityAt: 9_500, lastActivitySource: 'transcript' })
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
    const closing = bridge.closeAgent({ callerSessionId: 'caller', target: { sessionId: 'agent-1' } })
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
      target: { sessionId: 'agent-1' },
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
      displayLabel: 'A2',
      delivery: { ok: true, acceptance: { kind: 'user', acceptedAt: 10_000 } },
    })
  })
})
