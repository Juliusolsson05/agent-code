import { describe, expect, it } from 'vitest'
import {
  classifyCodexDocument,
  decodeCodexConversation,
  decodeJsonl,
} from 'agent-transcript-parser'
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

  it('strips a last model step decoded from real Codex JSONL bytes', () => {
    // Hand-built ConversationEntry literals can stay green if decode ever
    // stops copying record.raw onto source.raw. This path is the one the
    // host actually runs: JSONL → classify → decode → cut. Shape is the
    // redacted tail of rollout-...01a08846...jsonl (user, earlier tool
    // cycle, last reasoning+tool cycle, item_completed/token_usage opaques,
    // cyber_policy task_complete).
    const jsonl = [
      '{"timestamp":"2026-09-10T00:00:00.000Z","type":"session_meta","payload":{"id":"01a08846-936d-7dd3-a91b-0f933d0d9f29"}}',
      '{"timestamp":"2026-09-10T00:00:01.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"continue"}]}}',
      '{"timestamp":"2026-09-10T00:00:02.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"verified"}]}}',
      '{"timestamp":"2026-09-10T00:00:03.000Z","type":"response_item","payload":{"type":"custom_tool_call","call_id":"call-kept","name":"exec","input":"{}"}}',
      '{"timestamp":"2026-09-10T00:00:04.000Z","type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"call-kept","output":"ok"}}',
      '{"timestamp":"2026-09-10T00:00:05.000Z","type":"response_item","payload":{"type":"reasoning","encrypted_content":"gAAAAABqofvzmK22","summary":[{"type":"summary_text","text":"next"}]}}',
      '{"timestamp":"2026-09-10T00:00:06.000Z","type":"response_item","payload":{"type":"custom_tool_call","call_id":"call-last","name":"exec","input":"{}"}}',
      '{"timestamp":"2026-09-10T00:00:07.000Z","type":"event_msg","payload":{"type":"item_completed","item":{"type":"CommandExecution"}}}',
      '{"timestamp":"2026-09-10T00:00:08.000Z","type":"token_usage_record","payload":{}}',
      '{"timestamp":"2026-09-10T00:00:09.000Z","type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"call-last","output":"flagged-input"}}',
      '{"timestamp":"2026-09-10T00:00:10.000Z","type":"event_msg","payload":{"type":"task_complete","last_agent_message":null,"error":{"message":"This content was flagged for possible cybersecurity risk.","codex_error_info":"cyber_policy"}}}',
    ].join('\n')

    const conversation = decodeCodexConversation(classifyCodexDocument(decodeJsonl(jsonl)).records)
    expect(conversationHasCodexCyberPolicyBlock(conversation)).toBe(true)

    const stripped = stripLastCodexCyberPolicyStep(conversation)
    expect(conversationHasCodexCyberPolicyBlock(stripped)).toBe(false)
    expect(kinds(stripped)).toEqual([
      'opaque:session_meta',
      'user',
      'assistant',
      'call:call-kept',
      'result:call-kept',
    ])
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
