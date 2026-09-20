import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// #854. `create_agent` delivered the bootstrap prompt immediately and returned
// `prompt_delivery_failed` if the child was not ready for one yet. The run
// journal says what "not ready yet" was, across 11 app runs and 55 recorded
// bootstrap failures:
//
//   26  prompt input is blocked by claude.trust-dialog
//   21  prompt input is still warming (composer-unpainted)
//    5  Codex: was not ready for prompt delivery (timeout)
//   …only 5 of the 55 ever reached the absorption stage.
//
// 47 of 55 clear on their own: a human answers a first-launch trust dialog in
// a fresh worktree, or a TUI finishes painting. The child was fine and the
// prompt was early — and the reply made it worse, because
// `disposition: retry-same-session` invited an immediate retry into the same
// window, and it is that second attempt that writes prompt bytes without Enter
// and leaves the orphaned draft the parent can only escape by closing the
// child.
//
// These drive the REAL MCP server, the REAL tool handler and the REAL
// OrchestrationBridge over an in-memory transport. The two true edges are
// faked: `sendToWindow` (no renderer here) and the session manager (no provider
// process).
// ---------------------------------------------------------------------------

const renderer = {
  requests: [] as Array<Record<string, unknown>>,
  children: 0,
}

vi.mock('@main/window/windowRegistry.js', () => ({
  windowForSession: () => 'test-window',
  sendToWindow: (_windowId: string, _channel: string, request: Record<string, unknown>) => {
    renderer.requests.push(request)
    queueMicrotask(() => {
      const type = request.type as string
      if (type === 'create-agent') {
        renderer.children += 1
        bridge.resolve({
          requestId: request.requestId as string,
          ok: true,
          type: 'create-agent',
          agent: {
            sessionId: `child-${renderer.children}`,
            kind: 'claude',
            cwd: '/tmp/project',
            orchestrationParentId: 'parent-1',
            orchestrationRootId: 'parent-1',
          },
        } as never)
        return
      }
      if (type === 'ensure-agent-live') {
        // `send_prompt` wakes the child before delivering; without an answer
        // in this shape it refuses long before the supersede flag matters.
        bridge.resolve({
          requestId: request.requestId as string,
          ok: true,
          type: 'ensure-agent-live',
          agent: {
            sessionId: request.sessionId as string,
            kind: 'claude',
            cwd: '/tmp/project',
            orchestrationParentId: 'parent-1',
            orchestrationRootId: 'parent-1',
          },
        } as never)
        return
      }
      if (type === 'read-agent') {
        bridge.resolve({
          requestId: request.requestId as string,
          ok: true,
          type: 'read-agent',
          output: {
            agent: {
              sessionId: request.sessionId as string,
              kind: 'claude',
              cwd: '/tmp/project',
              orchestrationParentId: 'parent-1',
              orchestrationRootId: 'parent-1',
            },
            messages: [],
          },
        } as never)
        return
      }
      if (type === 'mark-bootstrap-prompt-delivered') {
        bridge.resolve({
          requestId: request.requestId as string,
          ok: true,
          type: 'mark-bootstrap-prompt-delivered',
          agent: {
            sessionId: request.sessionId as string,
            kind: 'claude',
            cwd: '/tmp/project',
            orchestrationParentId: 'parent-1',
            orchestrationRootId: 'parent-1',
            orchestrationBootstrapPromptDelivered: true,
          },
        } as never)
        return
      }
      bridge.resolve({ requestId: request.requestId as string, ok: true, type, agents: [], closedSessionIds: [request.sessionId] } as never)
    })
    return true
  },
}))

const { OrchestrationBridge } = await import('@main/orchestration/OrchestrationBridge.js')
const { createBuiltInMcpServer } = await import('@mcp/runtime/createBuiltInMcpServer.js')

let bridge: InstanceType<typeof OrchestrationBridge>

/** The recorded shapes, verbatim in the fields the handler branches on. */
const NOT_READY_YET = {
  warming: {
    ok: false as const, message: 'Claude session child-1 prompt input is still warming (composer-unpainted)',
    stage: 'before-write' as const, code: 'not-ready',
    retrySafe: true, disposition: 'retry-same-session' as const,
    promptWritten: false, enterWritten: false,
  },
  trustDialog: {
    ok: false as const, message: 'Claude session child-1 prompt input is blocked by claude.trust-dialog',
    stage: 'before-write' as const, code: 'not-ready',
    retrySafe: true, disposition: 'retry-after-resolve' as const,
    promptWritten: false, enterWritten: false,
  },
}
/** A failure about a real ATTEMPT, which must keep failing loudly. */
const ABSORPTION_FAILED = {
  ok: false as const, message: 'Claude session child-1 did not visibly absorb the prompt and its composer could not be recovered',
  stage: 'absorption' as const, code: 'absorption-timeout',
  retrySafe: false, disposition: 'do-not-retry' as const,
  promptWritten: true, enterWritten: false,
}
const SESSION_UNUSABLE = {
  ok: false as const, message: 'Claude session child-1 cannot observe prompt acceptance',
  stage: 'before-write' as const, code: 'missing-capability',
  retrySafe: true, disposition: 'session-unusable' as const,
  promptWritten: false, enterWritten: false,
}

type Manager = {
  getSessionKind: ReturnType<typeof vi.fn>
  deliverPromptToAgent: ReturnType<typeof vi.fn>
  deliverPromptWhenReady: ReturnType<typeof vi.fn>
  canWaitForPromptReadiness: ReturnType<typeof vi.fn>
  releasePending?: () => void
}

function manager(
  immediate: Record<string, unknown>,
  pendingOutcome: Record<string, unknown> = { ok: true },
  // Claude and Codex have a readiness gate; OpenCode and Grok do not, and for
  // them a "wait" is one instant retry into the same window (#854 review).
  canWait = true,
): Manager {
  let release!: () => void
  const opened = new Promise<void>(resolve => { release = resolve })
  return {
    deliverPromptToAgent: vi.fn(async () => immediate),
    canWaitForPromptReadiness: vi.fn(() => canWait),
    // `send_prompt` refuses a non-agent session before it ever delivers.
    getSessionKind: vi.fn(() => 'claude'),
    // Resolves only when the test says the gate opened, which is what a
    // composer painting or a human answering the trust dialog is.
    deliverPromptWhenReady: vi.fn(async () => { await opened; return pendingOutcome }),
    releasePending: () => release(),
  }
}

async function create(sessionManager: Manager, args: Record<string, unknown> = { kind: 'claude', prompt: 'review it' }) {
  const server = createBuiltInMcpServer(
    { sessionId: 'parent-1', cwd: '/tmp/project', domains: ['orchestration'] },
    { orchestrationBridge: bridge as never, sessionManager: sessionManager as never },
  )
  const client = new Client({ name: 'bootstrap-pending-test', version: '0.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  try {
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    const result = await client.callTool({ name: 'orchestration_create_agent', arguments: args })
    return JSON.parse(((result.content as Array<{ text: string }>)[0]!).text) as Record<string, unknown>
  } finally {
    await client.close()
    await server.close()
  }
}

const marked = () => renderer.requests.filter(request => request.type === 'mark-bootstrap-prompt-delivered')
const closed = () => renderer.requests.filter(request => request.type === 'close-agent')

beforeEach(() => {
  renderer.requests = []
  renderer.children = 0
  bridge = new OrchestrationBridge()
})
afterEach(() => { vi.restoreAllMocks() })

describe('a child that is not ready YET keeps its prompt instead of losing it (#854)', () => {
  it.each([
    { name: 'a composer that has not painted', immediate: NOT_READY_YET.warming },
    { name: 'a first-launch trust dialog', immediate: NOT_READY_YET.trustDialog },
  ])('returns the child and says the prompt is pending: $name', async ({ immediate }) => {
    const sessions = manager(immediate)

    const result = await create(sessions)

    // The call SUCCEEDS: the child exists and is usable.
    expect(result.ok).toBe(true)
    expect((result.agent as { sessionId: string }).sessionId).toBe('child-1')
    // And it is honest about the prompt: not submitted, not lost.
    expect(result).toMatchObject({ promptSubmitted: false, promptPending: true })
    expect(result.promptPendingReason).toBe(immediate.message)
    // The parent is told not to send it again, because that retry is what
    // orphans a half-written draft.
    expect(String(result.message)).toMatch(/do not send it again/i)
    // A waiting prompt was actually armed, with the same text the immediate
    // attempt used.
    expect(sessions.deliverPromptWhenReady).toHaveBeenCalledTimes(1)
    expect(sessions.deliverPromptWhenReady.mock.calls[0]![1]).toBe(sessions.deliverPromptToAgent.mock.calls[0]![1])
    // The child is NOT closed: it is a healthy child with a late brief.
    expect(closed()).toEqual([])
    // And nothing claims the bootstrap landed before it did.
    expect(marked()).toEqual([])
  })

  it('does NOT promise a wait for a provider with no readiness gate', async () => {
    // OpenCode and Grok report not-readiness as an ordinary failure and have
    // nothing to subscribe to. Promising a wait there swapped a retry the
    // parent could act on for a silent loss it could not — the reply said "do
    // not send it again" and nothing ever sent it (#854 review).
    //
    // The justifying corpus contains zero OpenCode or Grok rows: all 63
    // recorded bootstrap failures are Claude or Codex. The conclusion was
    // drawn from two providers and applied to four.
    const sessions = manager(NOT_READY_YET.warming, { ok: true }, false)

    const result = await create(sessions)

    expect(result).toMatchObject({ ok: false, error: 'prompt_delivery_failed', retrySafe: true })
    expect(sessions.deliverPromptWhenReady).not.toHaveBeenCalled()
  })

  it('marks the bootstrap delivered only when the prompt actually lands', async () => {
    const sessions = manager(NOT_READY_YET.warming)

    const result = await create(sessions)
    expect(result.promptPending).toBe(true)
    expect(marked()).toEqual([])

    // The composer paints.
    sessions.releasePending!()
    await vi.waitFor(() => expect(marked()).toHaveLength(1))

    expect(marked()[0]).toMatchObject({ sessionId: 'child-1' })
  })

  it('does not mark anything when the wait ends without a delivery', async () => {
    // The child was closed while its brief waited, or the session went
    // terminal. Marking it delivered would tell every later `send_prompt` to
    // skip the handoff wrapper for a child that never received one.
    const sessions = manager(NOT_READY_YET.trustDialog, {
      ok: false, message: 'Prompt for session child-1 was not delivered (session-ended)',
      stage: 'before-write', code: 'not-ready', retrySafe: false,
      disposition: 'session-unusable', promptWritten: false, enterWritten: false,
    })

    await create(sessions)
    sessions.releasePending!()
    await vi.waitFor(() => expect(sessions.deliverPromptWhenReady).toHaveBeenCalled())
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(marked()).toEqual([])
  })

  it('still fails loudly when the attempt actually happened', async () => {
    // The control, and the line the fix must not cross: bytes were written.
    // Waiting and re-delivering after that risks a second copy of the prompt,
    // which is the other half of #854 rather than a fix for it.
    const sessions = manager(ABSORPTION_FAILED)

    const result = await create(sessions)

    expect(result).toMatchObject({ ok: false, error: 'prompt_delivery_failed' })
    expect(sessions.deliverPromptWhenReady).not.toHaveBeenCalled()
  })

  it('still cleans up a child the provider calls unusable', async () => {
    // Unchanged behaviour: `session-unusable` is an explicit provider verdict
    // that this session cannot be used again, and it is the only disposition
    // that authorises deleting the child.
    const sessions = manager(SESSION_UNUSABLE)

    const result = await create(sessions)

    expect(result).toMatchObject({ ok: false, error: 'prompt_delivery_failed' })
    expect(sessions.deliverPromptWhenReady).not.toHaveBeenCalled()
    expect(closed()).toHaveLength(1)
  })
})

describe('a hand-sent prompt replaces the waiting brief, and nothing else does (#854)', () => {
  it('orchestration_send_prompt says it supersedes', async () => {
    // The parent, told its child's brief is pending, sends the same thing
    // itself. That is the ONE delivery that means "replace it" — and
    // `deliverPromptToAgent` has seven callers, including a human typing in
    // the child's pane, the phone, the goal loop and two compaction paths. An
    // earlier version cancelled the waiter from all of them, so the moment a
    // human pressed Enter in that pane the brief was thrown away silently.
    const sessions = manager({ ok: true })
    const server = createBuiltInMcpServer(
      { sessionId: 'parent-1', cwd: '/tmp/project', domains: ['orchestration'] },
      { orchestrationBridge: bridge as never, sessionManager: sessions as never },
    )
    const client = new Client({ name: 'supersede-test', version: '0.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    try {
      await server.connect(serverTransport)
      await client.connect(clientTransport)
      // The child has to exist for send_prompt to reach delivery.
      await client.callTool({ name: 'orchestration_create_agent', arguments: { kind: 'claude' } })
      const reply = await client.callTool({
        name: 'orchestration_send_prompt',
        arguments: { sessionId: 'child-1', prompt: 'the brief, sent by hand' },
      })
      // If send_prompt refused before delivering, the assertion below would
      // pass or fail for a reason that has nothing to do with superseding.
      const parsed = JSON.parse(((reply.content as Array<{ text: string }>)[0]!).text) as Record<string, unknown>
      if (parsed.ok !== true) throw new Error(`send_prompt refused: ${JSON.stringify(parsed)}`)
    } finally {
      await client.close()
      await server.close()
    }

    const sent = sessions.deliverPromptToAgent.mock.calls.at(-1)
    expect(sent?.[5]).toMatchObject({ supersedesPendingPrompt: true })
  })
})
