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
  // What `read-agent` reports for `orchestrationBootstrapPromptDelivered`.
  // send_prompt wraps the prompt in the handoff exactly when this is not
  // true, and marks it only for a wrapped prompt (#1134).
  bootstrapDelivered: false,
  // What `list-agents` reports. `wait_agents` polls it; the #1134 review case
  // is a child whose LAST turn is done (`completed`) with a follow-up pending.
  listed: [] as Array<Record<string, unknown>>,
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
              ...(renderer.bootstrapDelivered ? { orchestrationBootstrapPromptDelivered: true } : {}),
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
      if (type === 'list-agents') {
        bridge.resolve({ requestId: request.requestId as string, ok: true, type, agents: renderer.listed } as never)
        return
      }
      if (type === 'read-run-outputs') {
        bridge.resolve({ requestId: request.requestId as string, ok: true, type, outputs: [] } as never)
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
  renderer.bootstrapDelivered = false
  renderer.listed = []
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

// ---------------------------------------------------------------------------
// #1134. `orchestration_send_prompt` had no such wait: it delivered once and,
// for a child that was not ready yet, replied `prompt_delivery_failed` with
// `disposition: retry-same-session`. The incident journals from 2026-08-30 to
// 2026-09-22 make that the largest single failure group — 36
// `send_prompt / before-write / not-ready / retry-same-session` — and the
// parent's retry lands in the same window, which is #854's orphaned-draft
// risk all over again.
// ---------------------------------------------------------------------------

async function connect(
  sessionManager: unknown,
  journal?: { recordIncident: ReturnType<typeof vi.fn> },
) {
  const server = createBuiltInMcpServer(
    { sessionId: 'parent-1', cwd: '/tmp/project', domains: ['orchestration'] },
    {
      orchestrationBridge: bridge as never,
      sessionManager: sessionManager as never,
      ...(journal ? { appRunJournal: journal as never } : {}),
    },
  )
  const client = new Client({ name: 'send-prompt-pending-test', version: '0.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args })
    return JSON.parse(((result.content as Array<{ text: string }>)[0]!).text) as Record<string, unknown>
  }
  return {
    call,
    send: (prompt: string, sessionId = 'child-1') =>
      call('orchestration_send_prompt', { sessionId, prompt }),
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}

describe('send_prompt to a child that is not ready YET keeps its prompt (#1134)', () => {
  it.each([
    { name: 'a composer that has not painted', immediate: NOT_READY_YET.warming },
    { name: 'a first-launch trust dialog', immediate: NOT_READY_YET.trustDialog },
  ])('replies pending and delivers it once the child is ready: $name', async ({ immediate }) => {
    const sessions = manager(immediate)
    const mcp = await connect(sessions)
    try {
      const result = await mcp.send('look at the failing test')

      // Not an error: nothing failed, the prompt is early.
      expect(result).toMatchObject({
        ok: true, sessionId: 'child-1', promptSubmitted: false, promptPending: true,
      })
      expect(result.promptPendingReason).toBe(immediate.message)
      // The retry is exactly what orphans a half-written draft.
      expect(String(result.message)).toMatch(/do not send it again/i)
      // The SAME text the direct attempt used waits — the handoff wrapper
      // included, since this child never got its bootstrap.
      expect(sessions.deliverPromptWhenReady).toHaveBeenCalledTimes(1)
      const [waitedFor, waitedPrompt, , waitOptions] = sessions.deliverPromptWhenReady.mock.calls[0]!
      expect(waitedFor).toBe('child-1')
      expect(waitedPrompt).toBe(sessions.deliverPromptToAgent.mock.calls[0]![1])
      expect(String(waitedPrompt)).toContain('look at the failing test')
      // It replaces whatever else was waiting instead of being refused by it.
      expect(waitOptions).toMatchObject({ supersedesPendingPrompt: true })
      // Nothing claims the bootstrap landed before it did.
      expect(marked()).toEqual([])

      // The composer paints.
      sessions.releasePending!()
      await vi.waitFor(() => expect(marked()).toHaveLength(1))
      expect(marked()[0]).toMatchObject({ sessionId: 'child-1' })
    } finally {
      await mcp.close()
    }
  })

  it('does not mark a bootstrap for a follow-up to a child that already has one', async () => {
    // Only a WRAPPED prompt is the bootstrap. The mark is keyed off what this
    // call actually sent, not off "a send_prompt landed".
    renderer.bootstrapDelivered = true
    const sessions = manager(NOT_READY_YET.warming)
    const mcp = await connect(sessions)
    try {
      const result = await mcp.send('and now the docs')
      expect(result.promptPending).toBe(true)
      // Sent raw: no handoff wrapper around a follow-up.
      expect(sessions.deliverPromptWhenReady.mock.calls[0]![1]).toBe('and now the docs')

      sessions.releasePending!()
      await sessions.deliverPromptWhenReady.mock.results[0]!.value
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(marked()).toEqual([])
    } finally {
      await mcp.close()
    }
  })

  it('journals a pending prompt that never lands as send_prompt_pending', async () => {
    // The parent was told "pending, do not resend". If that promise is then
    // broken — the child closed, the session went terminal, a newer prompt
    // replaced it — the journal is the only place it can be counted.
    const journal = { recordIncident: vi.fn() }
    const sessions = manager(NOT_READY_YET.trustDialog, {
      ok: false, message: 'Prompt for session child-1 was not delivered (session-ended)',
      stage: 'before-write', code: 'not-ready', retrySafe: false,
      disposition: 'session-unusable', promptWritten: false, enterWritten: false,
    })
    const mcp = await connect(sessions, journal)
    try {
      await mcp.send('look at the failing test')
      expect(journal.recordIncident).not.toHaveBeenCalled()

      sessions.releasePending!()
      await vi.waitFor(() => expect(journal.recordIncident).toHaveBeenCalledTimes(1))
      expect(journal.recordIncident.mock.calls[0]![0]).toMatchObject({
        kind: 'orchestration.prompt_delivery_failed',
        reason: 'send_prompt_pending',
        context: { sessionId: 'child-1', message: expect.stringContaining('session-ended') },
      })
      expect(marked()).toEqual([])
    } finally {
      await mcp.close()
    }
  })

  it('keeps the failure reply for a provider with no readiness gate (OpenCode, Grok)', async () => {
    // #854 review: they report not-readiness as an ordinary failure and have
    // nothing to subscribe to. "Pending, do not resend" there is a silent
    // loss; the failure is a retry the parent can act on.
    const journal = { recordIncident: vi.fn() }
    const sessions = manager(NOT_READY_YET.warming, { ok: true }, false)
    const mcp = await connect(sessions, journal)
    try {
      const result = await mcp.send('look at the failing test')

      expect(result).toMatchObject({
        ok: false, error: 'prompt_delivery_failed',
        retrySafe: true, disposition: 'retry-same-session', promptSubmission: 'not-submitted',
      })
      expect(result.promptPending).toBeUndefined()
      expect(sessions.deliverPromptWhenReady).not.toHaveBeenCalled()
      expect(journal.recordIncident.mock.calls[0]![0]).toMatchObject({ reason: 'send_prompt' })
    } finally {
      await mcp.close()
    }
  })

  it('still fails loudly when the attempt actually happened', async () => {
    // Bytes were written. Waiting and re-delivering would be a second copy.
    const sessions = manager(ABSORPTION_FAILED)
    const mcp = await connect(sessions)
    try {
      const result = await mcp.send('look at the failing test')

      expect(result).toMatchObject({ ok: false, error: 'prompt_delivery_failed', promptSubmission: 'uncertain' })
      expect(sessions.deliverPromptWhenReady).not.toHaveBeenCalled()
    } finally {
      await mcp.close()
    }
  })
})

// ---------------------------------------------------------------------------
// The duplicate cases, against the REAL SessionManager. A faked manager would
// only prove the handler passes a flag; "the child receives one prompt" is a
// property of the manager's waiter map, its cancellation and the handler's
// ordering together, so all three are real here. The seam is the session's
// readiness gate, which the test opens.
// ---------------------------------------------------------------------------

const { SessionManager } = await import('@main/sessionManager.js')

function gatedClaudeChild() {
  let screen = '❯'
  let open = false
  let acceptance: Promise<{ kind: 'user'; acceptedAt: number }> | null = null
  return {
    write: vi.fn((data: string) => { if (data !== '\r') screen = `❯ ${data}` }),
    open: () => { open = true },
    isExited: () => false,
    snapshotScreen: () => screen,
    awaitReadyForPrompt: vi.fn(async () => (open
      ? { kind: 'ready' as const, waitedMs: 1 }
      : { kind: 'timeout' as const, waitedMs: 2_000, lastState: { kind: 'warming' as const, reason: 'composer-unpainted' as const } })),
    armPromptAcceptance: () => ({
      promise: acceptance ?? Promise.resolve({ kind: 'user' as const, acceptedAt: 123 }),
      cancel: vi.fn(),
    }),
    /** Hold a delivery open after its bytes are written: "mid-delivery". */
    holdAcceptance: () => {
      let settle!: () => void
      acceptance = new Promise(resolve => {
        settle = () => resolve({ kind: 'user' as const, acceptedAt: 123 })
      })
      return settle
    },
  }
}

function realManagerWith(child: ReturnType<typeof gatedClaudeChild>) {
  const sessions = new SessionManager()
  ;(sessions as unknown as { sessions: Map<string, unknown> }).sessions.set('child-1', {
    kind: 'claude', session: child,
  })
  return sessions
}

/** Every prompt body the child's composer ever received, Enter excluded. */
const written = (child: ReturnType<typeof gatedClaudeChild>) =>
  child.write.mock.calls.map(([data]) => data).filter(data => data !== '\r')

describe('one child, one prompt: a pending send_prompt never duplicates (#1134)', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }) })
  afterEach(() => { vi.useRealTimers() })

  it('replaces a create_agent brief that is still waiting, and only the send arrives', async () => {
    const child = gatedClaudeChild()
    const sessions = realManagerWith(child)
    const journal = { recordIncident: vi.fn() }
    const mcp = await connect(sessions, journal)
    try {
      const created = await mcp.call('orchestration_create_agent', { kind: 'claude', prompt: 'THE ORIGINAL BRIEF' })
      expect(created).toMatchObject({ ok: true, promptPending: true })
      await vi.advanceTimersByTimeAsync(10)

      const sent = await mcp.send('THE HAND-SENT BRIEF')
      expect(sent).toMatchObject({ ok: true, promptPending: true, supersededPendingPrompt: true })

      // The composer paints. Long past every waiter's re-arm, so a surviving
      // create_agent waiter would find the gate open and write its copy.
      child.open()
      await vi.advanceTimersByTimeAsync(10_000)

      expect(written(child)).toHaveLength(1)
      expect(written(child)[0]).toContain('THE HAND-SENT BRIEF')
      expect(written(child)[0]).not.toContain('THE ORIGINAL BRIEF')
      // The hand-sent prompt was the bootstrap (wrapped), so it is marked.
      expect(marked()).toHaveLength(1)
      // The replaced brief is journaled against create_agent, not lost
      // silently; the send that replaced it is not an incident.
      const reasons = journal.recordIncident.mock.calls.map(([incident]) => incident.reason)
      expect(reasons).toEqual(['create_agent_bootstrap_pending'])
    } finally {
      await mcp.close()
    }
  })

  it('lets a second send_prompt replace the first while it waits, and only the second arrives', async () => {
    const child = gatedClaudeChild()
    const sessions = realManagerWith(child)
    const mcp = await connect(sessions)
    try {
      const first = await mcp.send('FIRST FOLLOW-UP')
      expect(first).toMatchObject({ ok: true, promptPending: true })
      expect(first.supersededPendingPrompt).toBeUndefined()
      await vi.advanceTimersByTimeAsync(10)

      const second = await mcp.send('SECOND FOLLOW-UP')
      // The parent is TOLD the first will not arrive — latest wins, loudly.
      expect(second).toMatchObject({ ok: true, promptPending: true, supersededPendingPrompt: true })

      child.open()
      await vi.advanceTimersByTimeAsync(10_000)

      expect(written(child)).toHaveLength(1)
      expect(written(child)[0]).toContain('SECOND FOLLOW-UP')
    } finally {
      await mcp.close()
    }
  })

  it('does not leave a waiter behind when the send is delivered directly', async () => {
    // The control: a child that IS ready takes the prompt now, and the brief
    // create_agent left waiting must not follow it in.
    const child = gatedClaudeChild()
    const sessions = realManagerWith(child)
    const mcp = await connect(sessions)
    try {
      await mcp.call('orchestration_create_agent', { kind: 'claude', prompt: 'THE ORIGINAL BRIEF' })
      await vi.advanceTimersByTimeAsync(10)
      child.open()

      const sent = await mcp.send('THE HAND-SENT BRIEF')
      expect(sent).toMatchObject({ ok: true, supersededPendingPrompt: true })
      expect(sent.promptPending).toBeUndefined()
      await vi.advanceTimersByTimeAsync(10_000)

      expect(written(child)).toHaveLength(1)
      expect(written(child)[0]).toContain('THE HAND-SENT BRIEF')
    } finally {
      await mcp.close()
    }
  })
})

describe('#1134 review: the edges of a pending send_prompt', () => {
  it('does NOT queue a second copy behind a delivery that is in progress', async () => {
    // The reservation refusal carries `disposition: retry-same-session`, the
    // same as a warming composer. If `isNotReadyYet` let it through, a
    // send_prompt arriving while a waiter DELIVERS the brief would arm a
    // second waiter — nothing in the map to supersede, since the delivering
    // waiter already left it — and the same brief would land twice. The
    // parent must get the failure instead.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const child = gatedClaudeChild()
      const sessions = realManagerWith(child)
      const mcp = await connect(sessions)
      try {
        const created = await mcp.call('orchestration_create_agent', { kind: 'claude', prompt: 'THE BRIEF' })
        expect(created).toMatchObject({ ok: true, promptPending: true })
        await vi.advanceTimersByTimeAsync(10)

        // The trust dialog is answered; the waiter writes the brief and is
        // now holding the delivery reservation while acceptance is pending.
        const settle = child.holdAcceptance()
        child.open()
        await vi.advanceTimersByTimeAsync(3_000)
        expect(written(child)).toHaveLength(1)

        const sent = await mcp.send('THE BRIEF')
        expect(sent).toMatchObject({ ok: false, error: 'prompt_delivery_failed', code: 'delivery-in-flight' })
        expect(sent.promptPending).toBeUndefined()

        settle()
        await vi.advanceTimersByTimeAsync(10_000)
        // Exactly one copy, ever.
        expect(written(child)).toHaveLength(1)
        expect(written(child)[0]).toContain('THE BRIEF')
      } finally {
        await mcp.close()
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports a waiter that the ARM replaced, not only one the direct attempt replaced', async () => {
    // A waiter can arm between send_prompt's direct attempt and its own arm
    // (the direct attempt spans provider awaits). The arm replaces it; the
    // parent has to hear about that, or it believes a prompt is pending that
    // will never arrive.
    const sessions = manager(NOT_READY_YET.warming)
    sessions.deliverPromptWhenReady.mockImplementation(async (
      _id: string, _prompt: string,
      record?: (event: string) => void,
    ) => {
      // The real manager emits this synchronously, before its first await.
      record?.('pending-superseded')
      return await new Promise(() => {})
    })
    const mcp = await connect(sessions)
    try {
      const result = await mcp.send('look at the failing test')
      expect(result).toMatchObject({ ok: true, promptPending: true, supersededPendingPrompt: true })
    } finally {
      await mcp.close()
    }
  })

  it('keeps wait_agents waiting while a follow-up to a completed child is pending', async () => {
    // Both reviewers: `prompt_sent` was keyed off `lastPromptSubmittedAt`,
    // which is written only when a prompt LANDS. A child whose last turn is
    // done reads `completed`, so `wait_agents` returned done at once with the
    // previous turn's output — the parent had just been told its follow-up
    // was pending, and took the old answer as the new one.
    renderer.bootstrapDelivered = true
    renderer.listed = [{
      sessionId: 'child-1', kind: 'claude', cwd: '/tmp/project',
      orchestrationParentId: 'parent-1', orchestrationRootId: 'parent-1',
      lifecycleState: 'completed', completedAt: Date.now() - 60_000, lastActivityAt: Date.now() - 60_000,
    }]
    const sessions = manager(NOT_READY_YET.warming, {
      ok: false, message: 'Prompt for session child-1 was not delivered (session-ended)',
      stage: 'before-write', code: 'not-ready', retrySafe: false,
      disposition: 'session-unusable', promptWritten: false, enterWritten: false,
    })
    const mcp = await connect(sessions)
    const waitOnce = () => mcp.call('orchestration_wait_agents', {
      sessionIds: ['child-1'], timeoutMs: 1_000, pollIntervalMs: 250,
    })
    try {
      // The control: nothing pending, a completed child IS done.
      expect(await waitOnce()).toMatchObject({ done: true })

      expect(await mcp.send('and now the docs')).toMatchObject({ promptPending: true })
      const waiting = await waitOnce()
      expect(waiting.done).toBe(false)
      expect((waiting.agents as Array<{ lifecycleState: string }>)[0]!.lifecycleState).toBe('prompt_sent')

      // The wait ends without a delivery: the pending state must clear, or a
      // dead promise would hold every later wait_agents open until its TTL.
      sessions.releasePending!()
      await sessions.deliverPromptWhenReady.mock.results[0]!.value
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(await waitOnce()).toMatchObject({ done: true })
    } finally {
      await mcp.close()
    }
  })
})
