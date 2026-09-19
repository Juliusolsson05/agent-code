import { Buffer } from 'node:buffer'

import { SemanticChannel } from 'claude-code-headless/channels/SemanticChannel'
import { ClaudeProxyAdapter } from 'claude-code-headless/proxy/ClaudeProxyAdapter'
import { createRecordedAdapterHarness } from 'codex-headless/proxy/testing/adapterHarness'

import { foldSemanticEvent } from '@renderer/session-runtime/semantic/foldEvent'
import { reduceStreamPhase } from '@renderer/session-runtime/semantic/streamPhaseMachine'
import type { StreamPhaseState } from '@renderer/session-runtime/semantic/streamPhaseMachine'
import { emptySemanticRuntime } from '@renderer/session-runtime/state'
import type { SemanticRuntimeState, StreamPhase } from '@renderer/session-runtime/state'

// Real Claude and Codex proxy adapters wired to the REAL renderer reducers, in the
// order the desktop hook runs them (useIpcSubscriptions' semantic handler:
// foldSemanticEvent, then reduceStreamPhase on the post-fold turn). Only the
// provider traffic is synthetic.
//
// WHY shared: the turn clock across sleep (#963) and the analytics working-state
// equivalence (#964) must drive providers identically. The equivalence test only
// proves the recorder agrees with the counter if it replays the traffic the
// counter tests already pin; two hand-copied drivers would drift apart silently.
//
// Frame CONTENT is synthetic; only the shapes follow the recorded wire.

export const MODEL = 'claude-opus-4-8'

export type Frame = Record<string, unknown>

function sse(frames: Frame[]): string {
  return frames.map(frame => `event: ${String(frame.type)}\ndata: ${JSON.stringify(frame)}\n\n`).join('')
}

export function request(adapter: ClaudeProxyAdapter, flowId: number): void {
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

export function chunk(adapter: ClaudeProxyAdapter, flowId: number, frames: Frame[]): void {
  adapter.handleTransportEvent({
    kind: 'response-chunk',
    flow_id: flowId,
    path: '/v1/messages',
    chunk_b64: Buffer.from(sse(frames)).toString('base64'),
  } as never)
}

export function responseEnd(adapter: ClaudeProxyAdapter, flowId: number): void {
  adapter.handleTransportEvent({ kind: 'response-end', flow_id: flowId, path: '/v1/messages' } as never)
}

export const messageStart = (id: string): Frame => ({
  type: 'message_start',
  message: { id, model: MODEL, usage: { input_tokens: 10 } },
})
export const thinkingStart = (index: number): Frame => ({
  type: 'content_block_start',
  index,
  content_block: { type: 'thinking', thinking: '' },
})
export const thinkingDelta = (index: number): Frame => ({
  type: 'content_block_delta',
  index,
  delta: { type: 'thinking_delta', thinking: 'synthetic thinking' },
})
export const messageEnd = (): Frame[] => [
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 42 } },
  { type: 'message_stop' },
]

export type Pane = { semantic: SemanticRuntimeState; phase: StreamPhaseState }

export const IDLE_PHASE: StreamPhaseState = {
  streamPhase: 'idle',
  streamPhasePendingToolName: null,
  streamPhasePendingToolUseId: null,
  turnStartedAt: null,
  phaseChangedAt: null,
  submittedAt: null,
}

/** Called after the pane has folded each event, with the post-event pane. */
export type PaneEventObserver = (ev: Record<string, unknown>, pane: Pane) => void

/** Fold one semantic event exactly as the desktop hook does, recording phases
 *  and stops for assertions. */
export function paneReducer(kind: 'claude' | 'codex', onEvent?: PaneEventObserver) {
  let pane: Pane = { semantic: emptySemanticRuntime(), phase: IDLE_PHASE }
  const phases: StreamPhase[] = []
  const stops: Record<string, unknown>[] = []
  return {
    apply(ev: Record<string, unknown>): void {
      const semantic = foldSemanticEvent(pane.semantic, ev, kind)
      pane = { semantic, phase: reduceStreamPhase(pane.phase, ev, semantic.currentTurn) }
      if (ev.type === 'stream_phase') phases.push(ev.phase as StreamPhase)
      if (ev.type === 'turn_stopped') stops.push(ev)
      onEvent?.(ev, pane)
    },
    phases,
    stops,
    get pane(): Pane {
      return pane
    },
  }
}

/** One Claude pane: adapter → channel → the renderer's fold + phase machine. */
export function mountClaudePane(onEvent?: PaneEventObserver) {
  const channel = new SemanticChannel()
  const adapter = new ClaudeProxyAdapter({ channel, getSessionModel: () => MODEL })
  const reducer = paneReducer('claude', onEvent)
  channel.on('event', (ev: Record<string, unknown>) => reducer.apply(ev))
  return { adapter, reducer }
}

const CODEX_UPSTREAM = 'https://chatgpt.com/backend-api/codex/responses'

/** One Codex pane. Its adapter arms a watchdog interval, so mount it after the
 *  test has set the clock it wants the watchdog to measure from. */
export function mountCodexPane(onEvent?: PaneEventObserver) {
  const { proxy, semantic, adapter } = createRecordedAdapterHarness()
  const reducer = paneReducer('codex', onEvent)
  semantic.on('event', (ev: Record<string, unknown>) => reducer.apply(ev))
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
  return { adapter, reducer, request, frames, end }
}

export const created = (id: string): Frame => ({ type: 'response.created', response: { id } })
export const reasoningAdded = (index: number): Frame => ({
  type: 'response.output_item.added',
  output_index: index,
  item: { id: `rs_${index}`, type: 'reasoning' },
})
export const functionCall = (index: number): Frame[] => [
  { type: 'response.output_item.added', output_index: index, item: { id: `fc_${index}`, type: 'function_call', call_id: `call_${index}`, name: 'exec_command', status: 'in_progress' } },
  { type: 'response.output_item.done', output_index: index, item: { id: `fc_${index}`, type: 'function_call', call_id: `call_${index}`, name: 'exec_command', arguments: '{}' } },
]
export const completed = (id: string): Frame => ({ type: 'response.completed', response: { id } })
