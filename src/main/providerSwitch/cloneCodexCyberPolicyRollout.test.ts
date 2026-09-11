import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  classifyCodexDocument,
  decodeCodexConversation,
  decodeJsonl,
  codexNativeResumeProjector,
} from 'agent-transcript-parser'

import { cloneCodexCyberPolicyRollout } from './cloneCodexCyberPolicyRollout.js'

const FIXTURE = new URL(
  '../../../testing/fixtures/codex-cyber-policy-native-clone/source.jsonl',
  import.meta.url,
)

function loadFixture(): string {
  return readFileSync(FIXTURE, 'utf8')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function kinds(values: readonly Record<string, unknown>[]): string[] {
  return values.map(value => {
    const payload = value.payload
    const inner = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : {}
    if (value.type === 'response_item' && inner.type === 'custom_tool_call') {
      return `call:${inner.call_id}`
    }
    if (value.type === 'response_item' && inner.type === 'custom_tool_call_output') {
      return `result:${inner.call_id}`
    }
    if (value.type === 'response_item' && inner.type === 'message') {
      return String(inner.role)
    }
    if (value.type === 'response_item') return `item:${inner.type}`
    if (value.type === 'event_msg') return `event:${inner.type}`
    return String(value.type)
  })
}

describe('cloneCodexCyberPolicyRollout', () => {
  it('keeps native multi-agent records and array tool outputs from a real-shaped rollout', () => {
    // Fixture is a redacted tail of
    // rollout-2026-09-09T15-25-21-01a08846-936d-7dd3-a91b-0f933d0d9f29.jsonl.
    // The lossy native-resume projector dropped every agent_message and
    // stringified every tool output on the live fork 7ef23509. This test is
    // the contract that would have failed that write.
    const values = cloneCodexCyberPolicyRollout(loadFixture(), {
      targetSessionId: 'clone-session',
      now: '2026-09-11T02:52:59.701Z',
    })

    expect(kinds(values)).toEqual([
      'session_meta',
      'developer',
      'inter_agent_communication_metadata',
      'item:agent_message',
      'user',
      'assistant',
      'call:call-kept',
      'result:call-kept',
      'item:reasoning',
      'call:call-prev',
      'result:call-prev',
      'event:task_complete',
    ])

    const meta = values[0]?.payload as Record<string, unknown>
    expect(meta.id).toBe('clone-session')
    expect(meta.session_id).toBe('clone-session')
    expect(meta.timestamp).toBe('2026-09-11T02:52:59.701Z')
    expect(meta.originator).toBe('codex-tui')
    expect(meta.cwd).toBe('/project')

    const keptOutput = values.find(value => {
      const payload = value.payload as Record<string, unknown> | undefined
      return payload?.type === 'custom_tool_call_output' && payload.call_id === 'call-kept'
    })?.payload as Record<string, unknown>
    expect(Array.isArray(keptOutput.output)).toBe(true)

    const lastRecord = values.at(-1) as Record<string, unknown>
    const last = lastRecord.payload as Record<string, unknown>
    expect(last.type).toBe('task_complete')
    expect(last.error).toBeUndefined()
    expect(last.last_agent_message).toBe('I’m writing the database and CLI contracts now.')
    expect(last.turn_id).toBe('clone-session')
    expect(lastRecord.ordinal).toBe(11)
    expect(JSON.stringify(values)).not.toContain('cyber_policy')
    expect(JSON.stringify(values)).not.toContain('call-last')
  })

  it('documents why this path cannot use projectNativeResume', () => {
    const conversation = decodeCodexConversation(
      classifyCodexDocument(decodeJsonl(loadFixture())).records,
    )
    const projected = codexNativeResumeProjector.projectNativeResume(conversation, {
      cwd: '/project',
      targetSessionId: 'clone-session',
      now: '2026-09-11T02:52:59.701Z',
      cliVersion: '0.154.0',
      modelProvider: 'openai',
      model: 'gpt-5',
    })
    const hasNativeAgentMessage = projected.values.some(value => (
      value.type === 'response_item'
      && isRecord(value.payload)
      && value.payload.type === 'agent_message'
    ))
    expect(hasNativeAgentMessage).toBe(false)
    expect(JSON.stringify(projected.values)).not.toContain('inter_agent_communication_metadata')
    const outputs = projected.values.filter(value => {
      const payload = value.payload as Record<string, unknown> | undefined
      return payload?.type === 'custom_tool_call_output'
    })
    expect(outputs.length).toBeGreaterThan(0)
    expect(outputs.every(value => typeof (value.payload as Record<string, unknown>).output === 'string')).toBe(true)
  })
})
