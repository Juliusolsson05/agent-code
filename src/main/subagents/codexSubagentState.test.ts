import { describe, expect, it } from 'vitest'

import {
  buildCodexSubAgentState,
  extractCodexSpawnCall,
  extractCodexSpawnOutput,
  extractCodexSubagentNotification,
} from './codexSubagentState'

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
    const state = buildCodexSubAgentState({
      toolUseId: 'call_spawn',
      agentId: 'child-thread',
      spawn: {
        callId: 'call_spawn',
        agentType: 'explorer',
        description: 'Read the debug bundle.',
      },
      output: { callId: 'call_spawn', agentId: 'child-thread', nickname: 'Cicero' },
      notification: { agentId: 'child-thread', status: 'completed' },
      childEntries: [
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
      ],
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
