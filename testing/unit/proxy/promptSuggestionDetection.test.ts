import { describe, it, expect } from 'vitest'

import { ClaudeProxyAdapter } from '../../../packages/claude-code-headless/src/proxy/ClaudeProxyAdapter'

// A recording channel double. The adapter publishes through many channel
// methods (startTurn, publishTextDelta, publishFlowIgnored, publishStreamPhase,
// publishPromptSuggestion, …); rather than stub each, a Proxy returns a
// recording function for ANY accessed property and logs the call under the
// method name. That keeps the test resilient to the adapter touching helper
// methods we don't assert on.
type Call = { method: string; arg: Record<string, unknown> }
function makeChannel(calls: Call[]) {
  return new Proxy(
    {},
    {
      get: (_t, prop) => (arg: Record<string, unknown>) => {
        calls.push({ method: String(prop), arg: arg ?? {} })
      },
    },
  ) as never
}

function b64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64')
}

// Build one chunk of SSE text covering a full single-text-block turn.
function sse(model: string, text: string): string {
  const frames = [
    { type: 'message_start', message: { id: 'msg_x', model, usage: {} } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} },
    { type: 'message_stop' },
  ]
  return frames.map(f => `event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`).join('')
}

function drive(adapter: ClaudeProxyAdapter, flow_id: number, body: string, streamText: string) {
  adapter.handleTransportEvent({
    kind: 'request',
    flow_id,
    method: 'POST',
    url: 'https://api.anthropic.com/v1/messages',
    host: 'api.anthropic.com',
    path: '/v1/messages',
    body_b64: body,
  } as never)
  adapter.handleTransportEvent({
    kind: 'response-chunk',
    flow_id,
    path: '/v1/messages',
    chunk_b64: Buffer.from(sse('claude-opus-4-8', streamText)).toString('base64'),
  } as never)
  adapter.handleTransportEvent({ kind: 'response-end', flow_id, path: '/v1/messages' } as never)
}

const TOOLS = new Array(10).fill({ name: 'Bash' })
const SYSTEM = [{ type: 'text', text: 'You are Claude Code' }]

describe('prompt-suggestion flow routing', () => {
  it('does NOT emit turn_started for a suggestion flow, and emits prompt_suggestion with the text', () => {
    const calls: Call[] = []
    const adapter = new ClaudeProxyAdapter({
      channel: makeChannel(calls),
      getSessionModel: () => 'claude-opus-4-8',
    })
    const suggestionBody = b64({
      model: 'claude-opus-4-8',
      max_tokens: 64000,
      tools: TOOLS,
      system: SYSTEM,
      messages: [
        { role: 'user', content: 'fix the bug' },
        { role: 'assistant', content: 'done' },
        { role: 'user', content: '[SUGGESTION MODE: Suggest what the user might type next' },
      ],
    })
    drive(adapter, 111, suggestionBody, 'run the tests')

    expect(calls.find(c => c.method === 'startTurn')).toBeUndefined()
    const sugg = calls.find(c => c.method === 'publishPromptSuggestion')
    expect(sugg).toBeDefined()
    expect(sugg?.arg.text).toBe('run the tests')
  })

  it('emits NO prompt_suggestion when the streamed text is filtered noise', () => {
    const calls: Call[] = []
    const adapter = new ClaudeProxyAdapter({
      channel: makeChannel(calls),
      getSessionModel: () => 'claude-opus-4-8',
    })
    const suggestionBody = b64({
      model: 'claude-opus-4-8',
      max_tokens: 64000,
      tools: TOOLS,
      system: SYSTEM,
      messages: [{ role: 'user', content: '[SUGGESTION MODE: ...' }],
    })
    drive(adapter, 222, suggestionBody, 'silence')

    expect(calls.find(c => c.method === 'publishPromptSuggestion')).toBeUndefined()
    expect(calls.find(c => c.method === 'startTurn')).toBeUndefined()
  })

  it('DOES emit turn_started for a normal turn (regression guard)', () => {
    const calls: Call[] = []
    const adapter = new ClaudeProxyAdapter({
      channel: makeChannel(calls),
      getSessionModel: () => 'claude-opus-4-8',
    })
    const normalBody = b64({
      model: 'claude-opus-4-8',
      max_tokens: 64000,
      tools: TOOLS,
      system: SYSTEM,
      messages: [{ role: 'user', content: 'fix the bug' }],
    })
    drive(adapter, 333, normalBody, 'Working on it')

    expect(calls.find(c => c.method === 'startTurn')).toBeDefined()
    expect(calls.find(c => c.method === 'publishPromptSuggestion')).toBeUndefined()
  })
})
