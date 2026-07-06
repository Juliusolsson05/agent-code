import { describe, expect, it } from 'vitest'

import { parseInboundFrame } from './scope.js'

// The scope gate is the v1 security line: anything a phone can make the Mac
// DO must survive this parser. These tests enumerate BOTH directions — every
// allowed type parses, and the specific capabilities we amputated for v1
// (shell exec, session lifecycle, provider switching) are rejected no matter
// how well-formed the frame looks. If a future phase widens the protocol,
// it must consciously edit both this file and messages.ts.

const TOKEN = 'v1.device.123.sig'

function frame(message: unknown): unknown {
  return { token: TOKEN, id: 'req-1', message }
}

describe('allowed inbound messages', () => {
  it.each([
    ['ping', { type: 'ping' }],
    ['send-prompt', { type: 'send-prompt', sessionId: 's1', text: 'hello agent' }],
    ['submit', { type: 'submit', sessionId: 's1' }],
    ['interrupt', { type: 'interrupt', sessionId: 's1' }],
    [
      'permission-reply (pty action)',
      {
        type: 'permission-reply',
        sessionId: 's1',
        action: { kind: 'pty', id: 'yes', label: 'Yes', data: '\r' },
      },
    ],
    [
      'permission-reply (custom action)',
      {
        type: 'permission-reply',
        sessionId: 's1',
        action: {
          kind: 'custom',
          id: 'q0',
          label: 'Answer',
          name: 'claude.ask-user-question',
          payload: { answers: [[0]] },
        },
      },
    ],
  ])('%s parses', (_label, message) => {
    const result = parseInboundFrame(frame(message))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.frame.token).toBe(TOKEN)
      expect(result.frame.id).toBe('req-1')
    }
  })
})

describe('out-of-scope and malformed frames', () => {
  it.each([
    // Capabilities that DO NOT EXIST in v1 — must be rejected even though
    // they look plausible. This is scope-by-protocol-shape.
    ['shell exec', { type: 'exec', sessionId: 's1', command: 'rm -rf /' }],
    ['session spawn', { type: 'spawn-session', cwd: '/tmp' }],
    ['session kill', { type: 'kill-session', sessionId: 's1' }],
    ['provider switch', { type: 'switch-provider', sessionId: 's1', to: 'codex' }],
    ['raw input', { type: 'send-input', sessionId: 's1', data: 'ls\r' }],
    // Malformed variants of allowed types.
    ['send-prompt without text', { type: 'send-prompt', sessionId: 's1' }],
    ['send-prompt empty text', { type: 'send-prompt', sessionId: 's1', text: '' }],
    ['submit without sessionId', { type: 'submit' }],
    ['permission-reply with raw string action', {
      type: 'permission-reply', sessionId: 's1', action: '\x03',
    }],
    ['no type at all', { sessionId: 's1' }],
  ])('%s is rejected', (_label, message) => {
    const result = parseInboundFrame(frame(message))
    expect(result.ok).toBe(false)
  })

  it('rejects frames without a token', () => {
    const result = parseInboundFrame({ message: { type: 'ping' } })
    expect(result.ok).toBe(false)
  })

  it('rejects non-object garbage without throwing', () => {
    for (const garbage of [null, undefined, 42, 'hi', [], '{"type":"ping"}']) {
      expect(parseInboundFrame(garbage).ok).toBe(false)
    }
  })
})
