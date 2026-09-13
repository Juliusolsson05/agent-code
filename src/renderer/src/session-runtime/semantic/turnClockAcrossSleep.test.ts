import { Buffer } from 'node:buffer'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SemanticChannel } from 'claude-code-headless/channels/SemanticChannel'
import { ClaudeProxyAdapter } from 'claude-code-headless/proxy/ClaudeProxyAdapter'
import { createRecordedAdapterHarness } from 'codex-headless/proxy/testing/adapterHarness'

import { foldSemanticEvent } from '@renderer/session-runtime/semantic/foldEvent'
import { reduceStreamPhase } from '@renderer/session-runtime/semantic/streamPhaseMachine'
import type { StreamPhaseState } from '@renderer/session-runtime/semantic/streamPhaseMachine'
import { emptySemanticRuntime } from '@renderer/session-runtime/state'
import type { SemanticRuntimeState, StreamPhase } from '@renderer/session-runtime/state'
import { submitJoinsLiveWork } from '@renderer/workspace/hook/actions/streaming'

// REPRODUCTION (#963): the in-feed "Thinking · 20h03m" counter after the laptop sleeps.
//
// READ BEFORE CHANGING AN EXPECTATION: these tests pin TODAY'S behaviour,
// including the broken parts, so the bug is proven against the real code
// instead of inferred from reading it. The stuck and sleep-inflated rows are the
// bug; they are not the contract. Stage 3 of
// docs/decomposition/agent-working-time.md inverts exactly those rows to the
// agreed behaviour BEFORE the fix is written. Rows marked "correct" (retry after
// wake, turn finished before sleep) must keep passing unchanged.
//
// The counter is WorkIndicator's `Date.now() - turnStartedAt` (useElapsedSeconds).
// This file drives the REAL Claude proxy adapter and the REAL renderer reducers
// in the order the desktop hook runs them (useIpcSubscriptions' semantic handler:
// foldSemanticEvent, then reduceStreamPhase on the post-fold turn), with only the
// wall clock simulated. Nothing here is a hand-written model of the pipeline, so
// what these tests observe is what a pane observes.
//
// Timings come from a real recording, not from imagination
// (docs/decomposition/agent-working-time.md, evidence case A):
//   - Claude transcript bringdown/a531e423…jsonl: prompt 2026-08-31 20:57:09 PDT,
//     last assistant entry 22:45:08, next entries after 09-01 08:01:57.
//   - /var/log/powermanagement: clamshell sleep 23:43:59 → wake 08:01:40.
//   - Claude's own `turn_duration` for that turn: 39,888,429 ms (11.08 h),
//     i.e. the provider also counted the whole sleep as turn time.
// Frame CONTENT is synthetic; only the shapes and times are from the recording.
//
// What "sleep" means for the proxy path: the TCP connection to the API dies while
// the lid is closed, so mitmproxy never forwards `response-end` for that flow.
// Whether Claude Code then retries is the provider's decision, so both outcomes
// are exercised.

const PDT = (local: string): number => Date.parse(`${local}-07:00`)
const PROMPT_AT = PDT('2026-08-31T20:57:09')
const LAST_STREAM_AT = PDT('2026-08-31T22:45:08')
const WAKE_AT = PDT('2026-09-01T08:01:40')
const HOUR = 3_600_000

const MODEL = 'claude-opus-4-8'

type Frame = Record<string, unknown>

function sse(frames: Frame[]): string {
  return frames.map(frame => `event: ${String(frame.type)}\ndata: ${JSON.stringify(frame)}\n\n`).join('')
}

function request(adapter: ClaudeProxyAdapter, flowId: number): void {
  // The sidecar filter reads the request body; a primary-model conversation
  // request with tools and a system prompt is what a real turn sends.
  const body = {
    model: MODEL,
    max_tokens: 64_000,
    tools: new Array(10).fill({ name: 'Bash' }),
    system: [{ type: 'text', text: 'You are Claude Code' }],
    messages: [{ role: 'user', content: 'synthetic prompt' }],
  }
  adapter.handleTransportEvent({
    kind: 'request',
    flow_id: flowId,
    method: 'POST',
    url: 'https://api.anthropic.com/v1/messages',
    host: 'api.anthropic.com',
    path: '/v1/messages',
    body_b64: Buffer.from(JSON.stringify(body)).toString('base64'),
  } as never)
}

function chunk(adapter: ClaudeProxyAdapter, flowId: number, frames: Frame[]): void {
  adapter.handleTransportEvent({
    kind: 'response-chunk',
    flow_id: flowId,
    path: '/v1/messages',
    chunk_b64: Buffer.from(sse(frames)).toString('base64'),
  } as never)
}

function responseEnd(adapter: ClaudeProxyAdapter, flowId: number): void {
  adapter.handleTransportEvent({ kind: 'response-end', flow_id: flowId, path: '/v1/messages' } as never)
}

const messageStart = (id: string): Frame => ({
  type: 'message_start',
  message: { id, model: MODEL, usage: { input_tokens: 10 } },
})
const thinkingStart = (index: number): Frame => ({
  type: 'content_block_start',
  index,
  content_block: { type: 'thinking', thinking: '' },
})
const thinkingDelta = (index: number): Frame => ({
  type: 'content_block_delta',
  index,
  delta: { type: 'thinking_delta', thinking: 'synthetic thinking' },
})
const messageEnd = (): Frame[] => [
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 42 } },
  { type: 'message_stop' },
]

type Pane = { semantic: SemanticRuntimeState; phase: StreamPhaseState }

const IDLE_PHASE: StreamPhaseState = {
  streamPhase: 'idle',
  streamPhasePendingToolName: null,
  streamPhasePendingToolUseId: null,
  turnStartedAt: null,
  phaseChangedAt: null,
  submittedAt: null,
}

/** One Claude pane: adapter → channel → the renderer's fold + phase machine. */
function mountClaudePane() {
  const channel = new SemanticChannel()
  const adapter = new ClaudeProxyAdapter({ channel, getSessionModel: () => MODEL })
  let pane: Pane = { semantic: emptySemanticRuntime(), phase: IDLE_PHASE }
  const phases: StreamPhase[] = []
  channel.on('event', (ev: Record<string, unknown>) => {
    const semantic = foldSemanticEvent(pane.semantic, ev, 'claude')
    pane = { semantic, phase: reduceStreamPhase(pane.phase, ev, semantic.currentTurn) }
    if (ev.type === 'stream_phase') phases.push(ev.phase as StreamPhase)
  })
  return {
    adapter,
    phases,
    get pane(): Pane {
      return pane
    },
  }
}

/** Exactly what WorkIndicator paints after its phase label, in seconds. */
function counterSeconds(phase: StreamPhaseState): number | null {
  if (phase.streamPhase === 'idle' || phase.turnStartedAt === null) return null
  return Math.max(0, Math.floor((Date.now() - phase.turnStartedAt) / 1000))
}

/** A turn that was streaming thinking right up to the moment the lid closed. */
function streamUntilSleep(pane: ReturnType<typeof mountClaudePane>): void {
  vi.setSystemTime(PROMPT_AT)
  request(pane.adapter, 1)
  chunk(pane.adapter, 1, [messageStart('msg_before_sleep'), thinkingStart(0), thinkingDelta(0)])
  vi.setSystemTime(LAST_STREAM_AT)
  chunk(pane.adapter, 1, [thinkingDelta(0)])
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('in-feed turn clock across a laptop sleep (Claude proxy)', () => {
  it('stamps the clock when the turn starts, and it is Thinking before the lid closes', () => {
    const pane = mountClaudePane()
    streamUntilSleep(pane)

    expect(pane.pane.phase.streamPhase).toBe('thinking')
    expect(pane.pane.phase.turnStartedAt).toBe(PROMPT_AT)
  })

  it('a stream the sleep severed, with no retry, keeps the pane Thinking on its pre-sleep clock indefinitely', () => {
    const pane = mountClaudePane()
    streamUntilSleep(pane)

    // Wake. The flow's socket died during sleep: no response-end, no chunk.
    vi.setSystemTime(WAKE_AT)
    expect(pane.pane.phase.streamPhase).toBe('thinking')
    expect(counterSeconds(pane.pane.phase)).toBe((WAKE_AT - PROMPT_AT) / 1000)

    // Nothing is scheduled that could ever close the flow: the adapter's only
    // stale-flow reap runs inside the NEXT flow's first chunk.
    expect(vi.getTimerCount()).toBe(0)

    // A prompt typed now "joins live work", so optimistic submit stamps no new
    // clock (streaming.ts submitJoinsLiveWork): the next turn inherits this one.
    expect(submitJoinsLiveWork({ semantic: pane.pane.semantic, streamPhase: pane.pane.phase.streamPhase })).toBe(true)

    // The next morning it is still counting: the reported "Thinking · 20h".
    vi.setSystemTime(PROMPT_AT + 20 * HOUR + 3 * 60_000)
    expect(pane.pane.phase.streamPhase).toBe('thinking')
    expect(counterSeconds(pane.pane.phase)).toBe(20 * 3600 + 3 * 60)
  })

  it('a retry after wake reaps the severed stream and restarts the clock at the retry', () => {
    const pane = mountClaudePane()
    streamUntilSleep(pane)

    vi.setSystemTime(WAKE_AT)
    request(pane.adapter, 2)
    chunk(pane.adapter, 2, [messageStart('msg_after_wake'), thinkingStart(0)])

    expect(pane.phases).toContain('idle')
    expect(pane.pane.phase.streamPhase).toBe('thinking')
    expect(pane.pane.phase.turnStartedAt).toBe(WAKE_AT)
    expect(counterSeconds(pane.pane.phase)).toBe(0)
  })

  it('a turn that finished before the lid closed shows no counter after wake', () => {
    const pane = mountClaudePane()
    streamUntilSleep(pane)
    chunk(pane.adapter, 1, messageEnd())
    responseEnd(pane.adapter, 1)

    vi.setSystemTime(WAKE_AT)
    expect(pane.pane.phase.streamPhase).toBe('idle')
    expect(counterSeconds(pane.pane.phase)).toBeNull()
  })

  it('a tool that runs across the sleep and returns after wake counts the whole sleep as Thinking time', () => {
    // The recorded case A shape: a tool result, then the turn carried on after
    // wake and Claude wrote an 11.08 h turn_duration. Nothing is stuck here —
    // the turn is genuinely live — but the clock includes the night.
    const pane = mountClaudePane()
    vi.setSystemTime(PROMPT_AT)
    request(pane.adapter, 1)
    chunk(pane.adapter, 1, [
      messageStart('msg_tool_call'),
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"synthetic"}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 12 } },
      { type: 'message_stop' },
    ])
    responseEnd(pane.adapter, 1)
    expect(pane.pane.phase.streamPhase).toBe('awaiting-tool')

    // The tool finishes after wake and Claude sends the next request.
    vi.setSystemTime(WAKE_AT)
    request(pane.adapter, 2)
    chunk(pane.adapter, 2, [messageStart('msg_after_tool'), thinkingStart(0)])

    expect(pane.pane.phase.streamPhase).toBe('thinking')
    expect(pane.pane.phase.turnStartedAt).toBe(PROMPT_AT)
    expect(counterSeconds(pane.pane.phase)).toBe((WAKE_AT - PROMPT_AT) / 1000)
  })
})

// ---------------------------------------------------------------------------
// Codex. Its adapter differs in the one way that matters here: it arms a
// watchdog interval (10 s tick, 60 s silence) that seals a silent active turn.
// Timers do not fire while the machine sleeps, so the first tick after wake is
// modelled as `advanceTimersByTime(10_000)` after the wall-clock jump.
// ---------------------------------------------------------------------------

const CODEX_UPSTREAM = 'https://chatgpt.com/backend-api/codex/responses'

function mountCodexPane() {
  const { proxy, semantic } = createRecordedAdapterHarness()
  let pane: Pane = { semantic: emptySemanticRuntime(), phase: IDLE_PHASE }
  semantic.on('event', (ev: Record<string, unknown>) => {
    const next = foldSemanticEvent(pane.semantic, ev, 'codex')
    pane = { semantic: next, phase: reduceStreamPhase(pane.phase, ev, next.currentTurn) }
  })
  const request = (requestId: string): void => {
    proxy.emit('event', { kind: 'request', requestId, method: 'POST', path: '/v1/responses', upstream: CODEX_UPSTREAM, endpoint: 'responses' })
  }
  const frames = (requestId: string, payloads: Frame[]): void => {
    const body = Buffer.from(payloads.map(payload => `data: ${JSON.stringify(payload)}\n\n`).join(''))
    proxy.emit('event', { kind: 'response-chunk', requestId, path: '/v1/responses', size: body.length, chunk: body, endpoint: 'responses' })
  }
  const end = (requestId: string): void => {
    proxy.emit('event', { kind: 'response-end', requestId, path: '/v1/responses', bytes: 0, endpoint: 'responses' })
  }
  return {
    request,
    frames,
    end,
    get pane(): Pane {
      return pane
    },
  }
}

const created = (id: string): Frame => ({ type: 'response.created', response: { id } })
const reasoningAdded = (index: number): Frame => ({
  type: 'response.output_item.added',
  output_index: index,
  item: { id: `rs_${index}`, type: 'reasoning' },
})
const functionCall = (index: number): Frame[] => [
  { type: 'response.output_item.added', output_index: index, item: { id: `fc_${index}`, type: 'function_call', call_id: `call_${index}`, name: 'exec_command', status: 'in_progress' } },
  { type: 'response.output_item.done', output_index: index, item: { id: `fc_${index}`, type: 'function_call', call_id: `call_${index}`, name: 'exec_command', arguments: '{}' } },
]
const completed = (id: string): Frame => ({ type: 'response.completed', response: { id } })

describe('in-feed turn clock across a laptop sleep (Codex proxy)', () => {
  it('a reasoning stream the sleep severed shows the sleep until the first watchdog tick, then clears', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const pane = mountCodexPane()
    vi.setSystemTime(PROMPT_AT)
    pane.request('req-1')
    pane.frames('req-1', [created('resp_before_sleep'), reasoningAdded(0)])
    expect(pane.pane.phase.streamPhase).toBe('thinking')

    vi.setSystemTime(WAKE_AT)
    expect(counterSeconds(pane.pane.phase)).toBe((WAKE_AT - PROMPT_AT) / 1000)

    vi.advanceTimersByTime(10_000)
    expect(pane.pane.phase.streamPhase).toBe('idle')
    expect(counterSeconds(pane.pane.phase)).toBeNull()
  })

  it('a client tool that never returns after wake leaves the pane awaiting the tool on its pre-sleep clock', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const pane = mountCodexPane()
    vi.setSystemTime(PROMPT_AT)
    pane.request('req-1')
    pane.frames('req-1', [created('resp_tool'), ...functionCall(0), completed('resp_tool')])
    pane.end('req-1')
    expect(pane.pane.phase.streamPhase).toBe('awaiting-tool')

    vi.setSystemTime(WAKE_AT)
    vi.advanceTimersByTime(10_000)
    expect(pane.pane.phase.streamPhase).toBe('awaiting-tool')
    expect(counterSeconds(pane.pane.phase)).toBe((WAKE_AT - PROMPT_AT) / 1000 + 10)
  })

  it('a client tool that returns after wake continues the turn with the sleep counted as Thinking time', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const pane = mountCodexPane()
    vi.setSystemTime(PROMPT_AT)
    pane.request('req-1')
    pane.frames('req-1', [created('resp_tool'), ...functionCall(0), completed('resp_tool')])
    pane.end('req-1')

    vi.setSystemTime(WAKE_AT)
    pane.request('req-2')
    pane.frames('req-2', [created('resp_after_tool'), reasoningAdded(0)])

    expect(pane.pane.phase.streamPhase).toBe('thinking')
    expect(pane.pane.phase.turnStartedAt).toBe(PROMPT_AT)
    expect(counterSeconds(pane.pane.phase)).toBe((WAKE_AT - PROMPT_AT) / 1000)
  })
})
