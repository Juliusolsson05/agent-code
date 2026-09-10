import { describe, expect, it } from 'vitest'
import type { ConversationDocument, ConversationEntry } from 'agent-transcript-parser'

import {
  conversationHasCodexCyberPolicyBlock,
  stripLastCodexCyberPolicyStep,
} from './codexCyberPolicy.js'

function source(line: number, raw: Record<string, unknown> = {}): ConversationEntry['source'] {
  return { provider: 'codex', line, raw, evidence: [] }
}

function user(line: number, text: string): ConversationEntry {
  return {
    kind: 'message',
    role: 'user',
    content: [{ kind: 'text', text }],
    timestamp: `2026-09-10T00:00:0${line}.000Z`,
    source: source(line),
  }
}

function assistant(line: number, text: string): ConversationEntry {
  return {
    kind: 'message',
    role: 'assistant',
    content: [{ kind: 'text', text }],
    timestamp: `2026-09-10T00:00:0${line}.000Z`,
    source: source(line),
  }
}

function reasoning(line: number): ConversationEntry {
  return {
    kind: 'reasoning',
    text: `think-${line}`,
    encrypted: null,
    timestamp: `2026-09-10T00:00:0${line}.000Z`,
    source: source(line),
  }
}

function toolCall(line: number, callId: string): ConversationEntry {
  return {
    kind: 'tool-call',
    callId,
    name: 'exec',
    input: { cmd: callId },
    nativeKind: 'custom_tool_call',
    timestamp: `2026-09-10T00:00:0${line}.000Z`,
    source: source(line),
  }
}

function toolResult(line: number, callId: string): ConversationEntry {
  return {
    kind: 'tool-result',
    callId,
    output: `out-${callId}`,
    isError: null,
    nativeKind: 'custom_tool_call_output',
    timestamp: `2026-09-10T00:00:0${line}.000Z`,
    source: source(line),
  }
}

function opaqueEvent(line: number, payload: Record<string, unknown>): ConversationEntry {
  return {
    kind: 'opaque',
    nativeType: 'event_msg',
    timestamp: `2026-09-10T00:00:0${line}.000Z`,
    source: source(line, { type: 'event_msg', payload }),
  }
}

function cyberComplete(line: number): ConversationEntry {
  return opaqueEvent(line, {
    type: 'task_complete',
    turn_id: 'turn-last',
    last_agent_message: null,
    error: {
      message: 'This content was flagged for possible cybersecurity risk.',
      codex_error_info: 'cyber_policy',
    },
  })
}

function cleanComplete(line: number): ConversationEntry {
  return opaqueEvent(line, {
    type: 'task_complete',
    turn_id: 'turn-ok',
    last_agent_message: 'done',
  })
}

function document(entries: ConversationEntry[]): ConversationDocument {
  return {
    schemaVersion: 1,
    sourceProvider: 'codex',
    sourceSessionIds: ['source-session'],
    entries,
  }
}

function kinds(conversation: ConversationDocument): Array<ConversationEntry['kind'] | string> {
  return conversation.entries.map(entry => {
    if (entry.kind === 'message') return `${entry.role}`
    if (entry.kind === 'tool-call') return `call:${entry.callId}`
    if (entry.kind === 'tool-result') return `result:${entry.callId}`
    if (entry.kind === 'opaque') {
      const payload = entry.source.raw.payload
      const type = payload && typeof payload === 'object' && 'type' in payload
        ? String((payload as { type: unknown }).type)
        : entry.nativeType
      return `opaque:${type}`
    }
    return entry.kind
  })
}

describe('stripLastCodexCyberPolicyStep', () => {
  it('drops only the last sequential model step after a cyber_policy complete', () => {
    // Shape taken from ~/.codex/sessions/2026/09/09/rollout-...01a08846...jsonl:
    // earlier assistant work and a completed tool cycle stay; the trailing
    // reasoning + tool cluster that became the flagged request's newest input
    // is the cut. The failed generation itself wrote no response_item.
    const stripped = stripLastCodexCyberPolicyStep(document([
      user(1, 'build the mcp layer'),
      assistant(2, 'verified hermes'),
      toolCall(3, 'patch-1'),
      toolResult(4, 'patch-1'),
      reasoning(5),
      toolCall(6, 'sqlmap-read'),
      toolResult(7, 'sqlmap-read'),
      opaqueEvent(8, { type: 'token_count' }),
      cyberComplete(9),
    ]))

    expect(conversationHasCodexCyberPolicyBlock(stripped)).toBe(false)
    expect(kinds(stripped)).toEqual([
      'user',
      'assistant',
      'call:patch-1',
      'result:patch-1',
    ])
  })

  it('treats an assistant message that sits with its tools as one model step', () => {
    const stripped = stripLastCodexCyberPolicyStep(document([
      user(1, 'continue'),
      toolCall(2, 'earlier'),
      toolResult(3, 'earlier'),
      reasoning(4),
      assistant(5, 'writing the contracts'),
      toolCall(6, 'patch-2'),
      toolResult(7, 'patch-2'),
      cyberComplete(8),
    ]))

    expect(kinds(stripped)).toEqual([
      'user',
      'call:earlier',
      'result:earlier',
    ])
  })

  it('drops a trailing assistant-only generation when that is the last step', () => {
    const stripped = stripLastCodexCyberPolicyStep(document([
      user(1, 'continue'),
      toolCall(2, 'earlier'),
      toolResult(3, 'earlier'),
      reasoning(4),
      assistant(5, 'here is the flagged reply'),
      cyberComplete(6),
    ]))

    expect(kinds(stripped)).toEqual([
      'user',
      'call:earlier',
      'result:earlier',
    ])
  })

  it('drops a parallel tool batch as one model step', () => {
    const stripped = stripLastCodexCyberPolicyStep(document([
      user(1, 'continue'),
      assistant(2, 'checking both'),
      toolCall(3, 'a'),
      toolCall(4, 'b'),
      toolResult(5, 'a'),
      toolResult(6, 'b'),
      cyberComplete(7),
    ]))

    expect(kinds(stripped)).toEqual([
      'user',
    ])
  })

  it('ignores a recovered later task_complete that is not cyber_policy', () => {
    const conversation = document([
      user(1, 'hello'),
      assistant(2, 'ok'),
      cyberComplete(3),
      user(4, 'try again'),
      assistant(5, 'worked'),
      cleanComplete(6),
    ])
    expect(conversationHasCodexCyberPolicyBlock(conversation)).toBe(false)
    expect(() => stripLastCodexCyberPolicyStep(conversation)).toThrow(
      /No cybersecurity block at the end of this Codex session/,
    )
  })

  it('rejects a Claude conversation and a Codex file with no cyber block', () => {
    expect(() => stripLastCodexCyberPolicyStep({
      schemaVersion: 1,
      sourceProvider: 'claude',
      sourceSessionIds: ['x'],
      entries: [user(1, 'hi')],
    })).toThrow(/Codex/)
    expect(() => stripLastCodexCyberPolicyStep(document([
      user(1, 'hi'),
      assistant(2, 'ok'),
      cleanComplete(3),
    ]))).toThrow(/No cybersecurity block/)
  })
})
