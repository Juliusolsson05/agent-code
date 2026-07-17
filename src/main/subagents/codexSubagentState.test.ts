import { describe, expect, it } from 'vitest'

import {
  accumulateCodexSubAgentEntry,
  buildCodexSubAgentStateFromAccumulator,
  createCodexAccumulator,
  extractCodexSpawnCall,
  extractCodexSpawnOutput,
  extractCodexSubagentNotification,
  textFromCodexOutput,
  extractCodexWaitStatuses,
  isCodexWaitAgentCall,
} from './codexSubagentState'
import type { JsonlEntry } from '@preload/api/types.js'

describe('Codex subagent state', () => {
  it('extracts the parent spawn call and output join keys', () => {
    const spawn = extractCodexSpawnCall({
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'spawn_agent',
        call_id: 'call_spawn',
        arguments: JSON.stringify({
          agent_type: 'explorer',
          message: 'Inspect the child rollout shape.',
        }),
      },
    })
    const output = extractCodexSpawnOutput({
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'call_spawn',
        output: JSON.stringify({
          agent_id: '019eda6c-0573-7993-a01e-a1d839486a35',
          nickname: 'Cicero',
        }),
      },
    })

    expect(spawn).toEqual({
      callId: 'call_spawn',
      agentType: 'explorer',
      description: 'Inspect the child rollout shape.',
    })
    expect(output).toEqual({
      callId: 'call_spawn',
      agentId: '019eda6c-0573-7993-a01e-a1d839486a35',
      nickname: 'Cicero',
    })
  })

  it('does not create an unjoinable tracker entry for current task_name calls', () => {
    expect(extractCodexSpawnCall({
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'spawn_agent',
        call_id: 'named-task',
        arguments: JSON.stringify({ task_name: 'review', message: 'Inspect it' }),
      },
    })).toBeNull()
  })

  it('extracts the spawn output join key from { text } object output', () => {
    const output = extractCodexSpawnOutput({
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'call_spawn',
        output: { text: JSON.stringify({ agent_id: 'child-1', nickname: 'Plato' }) },
      },
    })
    expect(output).toEqual({ callId: 'call_spawn', agentId: 'child-1', nickname: 'Plato' })
  })

  it('extracts the spawn output join key from structured array output', () => {
    // feed audit Finding 11: array-shaped output used to drop the agent_id join
    // key, silently breaking parent↔child correlation. Now it resolves.
    const output = extractCodexSpawnOutput({
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'call_spawn',
        output: [
          { type: 'text', text: JSON.stringify({ agent_id: 'child-2', nickname: 'Aristotle' }) },
        ],
      },
    })
    expect(output).toEqual({ callId: 'call_spawn', agentId: 'child-2', nickname: 'Aristotle' })
  })

  it('returns null for array output that carries no agent_id', () => {
    const output = extractCodexSpawnOutput({
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'call_spawn',
        output: [{ type: 'text', text: 'no json here' }],
      },
    })
    expect(output).toBeNull()
  })

  describe('textFromCodexOutput', () => {
    it('passes a plain string through', () => {
      expect(textFromCodexOutput('hello')).toBe('hello')
    })
    it('reads a { text } object', () => {
      expect(textFromCodexOutput({ text: 'hi' })).toBe('hi')
    })
    it('joins array item text with newlines', () => {
      expect(
        textFromCodexOutput([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]),
      ).toBe('a\nb')
    })
    it('returns null for an array with no text items', () => {
      expect(textFromCodexOutput([{ type: 'image', data: 'x' }])).toBeNull()
    })
    it('returns null for an opaque object (never stringifies it)', () => {
      expect(textFromCodexOutput({ foo: 'bar' })).toBeNull()
    })
  })

  it('extracts Codex subagent completion notifications from synthetic user messages', () => {
    const notification = extractCodexSubagentNotification({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: '<subagent_notification>\n{"agent_path":"child-thread","status":"completed"}\n</subagent_notification>',
          },
        ],
      },
    })

    expect(notification).toEqual({
      agentId: 'child-thread',
      status: 'completed',
    })
  })

  it('builds Claude-compatible SubAgentState from a Codex child rollout', () => {
    // Ported from the deleted buildCodexSubAgentState (entries-array) oracle to
    // the live accumulator path: fold each rollout line exactly the way
    // CodexSubAgentTracker.readAppendedChild does, then project. The former
    // array builder was a parallel derivation nothing but this test used, so it
    // was removed (see the header comment mirroring the claude twin's decision).
    const childEntries: JsonlEntry[] = [
      {
        type: 'session_meta',
        timestamp: '2026-06-18T11:09:32.000Z',
        payload: {
          type: 'session_meta',
          id: 'child-thread',
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: 'parent-thread',
                agent_nickname: 'Cicero',
                agent_role: 'explorer',
              },
            },
          },
        },
      },
      {
        type: 'response_item',
        timestamp: '2026-06-18T11:09:35.000Z',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          call_id: 'call_exec',
          arguments: JSON.stringify({ command: 'rg subagent src' }),
        },
      },
      {
        type: 'response_item',
        timestamp: '2026-06-18T11:09:36.000Z',
        payload: {
          type: 'function_call_output',
          call_id: 'call_exec',
          output: 'src/main/subagents/index.ts',
        },
      },
      {
        type: 'event_msg',
        timestamp: '2026-06-18T11:09:40.000Z',
        payload: {
          type: 'task_complete',
        },
      },
    ]
    const acc = createCodexAccumulator()
    for (const entry of childEntries) accumulateCodexSubAgentEntry(acc, entry)
    const state = buildCodexSubAgentStateFromAccumulator({
      toolUseId: 'call_spawn',
      agentId: 'child-thread',
      spawn: {
        callId: 'call_spawn',
        agentType: 'explorer',
        description: 'Read the debug bundle.',
      },
      output: { callId: 'call_spawn', agentId: 'child-thread', nickname: 'Cicero' },
      notification: { agentId: 'child-thread', status: 'completed' },
      acc,
      // Pin nowMs so the staleness branch is deterministic; taskComplete already
      // forces 'done' here, but an explicit clock keeps the test independent of
      // wall time relative to the (fixed) rollout timestamps.
      nowMs: Date.parse('2026-06-18T11:09:41.000Z'),
    })

    expect(state).toMatchObject({
      toolUseId: 'call_spawn',
      agentId: 'child-thread',
      agentType: 'explorer',
      description: 'Read the debug bundle.',
      status: 'done',
      turnCount: 0,
      toolCalls: [
        {
          name: 'exec_command',
          headline: 'rg subagent src',
          status: 'done',
        },
      ],
      droppedToolCalls: 0,
      currentActivity: null,
    })
    expect(state.startedAt).toBe(Date.parse('2026-06-18T11:09:32.000Z'))
    expect(state.lastActivityAt).toBe(Date.parse('2026-06-18T11:09:40.000Z'))
  })
})

describe('#341 lifecycle: wait_agent terminal inference + staleness', () => {
  it('parses the wait_agent status output shape (verified against real rollouts)', () => {
    const waitCall = {
      timestamp: '2026-06-18T11:14:00.000Z',
      type: 'response_item',
      payload: { type: 'function_call', name: 'wait_agent', call_id: 'call_w1', arguments: '{}' },
    }
    expect(isCodexWaitAgentCall(waitCall)).toBe('call_w1')
    const output = {
      timestamp: '2026-06-18T11:14:37.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'call_w1',
        output: JSON.stringify({
          status: {
            'agent-a': { completed: 'all done' },
            'agent-b': { failed: 'crashed' },
          },
        }),
      },
    }
    const statuses = extractCodexWaitStatuses(output, new Set(['call_w1']))
    expect(statuses?.get('agent-a')).toBe('done')
    expect(statuses?.get('agent-b')).toBe('error')
  })

  it('ignores outputs of non-wait calls', () => {
    const output = {
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'call_other',
        output: JSON.stringify({ status: { x: { completed: 'y' } } }),
      },
    }
    expect(extractCodexWaitStatuses(output, new Set(['call_w1']))).toBeNull()
  })
})
