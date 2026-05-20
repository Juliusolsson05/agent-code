// CLAUDE PROXY API-ERROR RELEASE REGRESSION SCRIPT.
//
// WHY this focused script exists:
// Agent Code still uses small executable regression scripts while the
// broader test harness is being consolidated. This one captures the
// exact 2026-05-20 failure mode from an app debug bundle: Anthropic
// returned an SSE `overloaded_error`, the proxy adapter published the
// API error, but kept that failed flow as the active stream owner. The
// next user retry then streamed normally on the wire and was still
// ignored as "concurrent with active flow ...". The test is deliberately
// transport-level so it does not need a real Claude process or network.

import assert from 'node:assert/strict'

import { SemanticChannel } from '../packages/claude-code-headless/src/channels/SemanticChannel'
import type { SemanticEvent } from '../packages/claude-code-headless/src/channels/types'
import { ClaudeProxyAdapter } from '../packages/claude-code-headless/src/proxy/ClaudeProxyAdapter'

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function chunk(flowId: string, body: string) {
  return {
    kind: 'response-chunk' as const,
    flow_id: flowId,
    chunk_b64: Buffer.from(body, 'utf8').toString('base64'),
  }
}

const channel = new SemanticChannel()
const events: SemanticEvent[] = []
channel.on('event', event => events.push(event))

const adapter = new ClaudeProxyAdapter({ channel })

adapter.handleTransportEvent({
  kind: 'request',
  flow_id: 'failed-flow',
  method: 'POST',
  host: 'api.anthropic.com',
  path: '/v1/messages?beta=true',
})

adapter.handleTransportEvent(chunk(
  'failed-flow',
  sse('error', {
    type: 'error',
    error: {
      type: 'overloaded_error',
      message: 'Overloaded',
    },
  }),
))

assert.equal(events.some(event => event.type === 'api_error' && event.isOverloaded), true)

adapter.handleTransportEvent({
  kind: 'request',
  flow_id: 'retry-flow',
  method: 'POST',
  host: 'api.anthropic.com',
  path: '/v1/messages?beta=true',
})

adapter.handleTransportEvent(chunk(
  'retry-flow',
  [
    sse('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_retry',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-7',
        content: [],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    }),
    sse('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }),
    sse('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'RECOVERED' },
    }),
    sse('content_block_stop', {
      type: 'content_block_stop',
      index: 0,
    }),
    sse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 9 },
    }),
    sse('message_stop', {
      type: 'message_stop',
    }),
  ].join(''),
))

assert.equal(
  events.some(event =>
    event.type === 'flow_ignored' &&
    event.flowId === 'retry-flow' &&
    event.reason.includes('concurrent with active flow failed-flow'),
  ),
  false,
  'retry flow must not be ignored behind the failed overloaded flow',
)
assert.equal(events.some(event => event.type === 'turn_started' && event.turnId === 'msg_retry'), true)
assert.equal(
  events.some(event => event.type === 'turn_completed' && event.fullText === 'RECOVERED'),
  true,
)

console.log('claude proxy api-error release regression passed')
