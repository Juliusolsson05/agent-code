import { describe, expect, it } from 'vitest'

import { mapCodexRolloutToFeedEntries } from '@providers/codex/renderer/transcript/rollout'
import { isConversationEntry } from '@shared/types/transcript'

function userMessage(text: string): Record<string, unknown> {
  return {
    type: 'response_item',
    timestamp: '2026-06-18T11:12:00.000Z',
    payload: {
      type: 'message',
      id: 'msg_test',
      role: 'user',
      content: [{ type: 'input_text', text }],
    },
  }
}

describe('mapCodexRolloutToFeedEntries', () => {
  it('drops Codex subagent notifications instead of rendering them as user prompts', () => {
    const entries = mapCodexRolloutToFeedEntries(
      userMessage(
        '<subagent_notification>\n{"agent_path":"019eda6c-0573-7993-a01e-a1d839486a35","status":"completed"}\n</subagent_notification>',
      ),
    )

    expect(entries).toEqual([])
  })

  it('keeps real user prompts that quote the notification marker', () => {
    const entries = mapCodexRolloutToFeedEntries(
      userMessage('Why did Codex persist <subagent_notification> in the transcript?'),
    )

    expect(entries).toHaveLength(1)
    expect(entries[0]?.type).toBe('user')
  })

  it('still drops first-turn Codex bootstrap messages', () => {
    const entries = mapCodexRolloutToFeedEntries({
      type: 'response_item',
      timestamp: '2026-06-18T11:12:00.000Z',
      payload: {
        type: 'message',
        id: 'msg_bootstrap',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: '# AGENTS.md instructions for /Users/julius/project\n\n<INSTRUCTIONS />',
          },
          {
            type: 'input_text',
            text: '<environment_context>\n  <cwd>/Users/julius/project</cwd>\n</environment_context>',
          },
        ],
      },
    })

    expect(entries).toEqual([])
  })

  it('keeps unified apply_patch success as the result that completes its edit card', () => {
    const entries = mapCodexRolloutToFeedEntries({
      type: 'response_item',
      timestamp: '2026-07-12T11:12:00.000Z',
      payload: {
        type: 'custom_tool_call_output',
        call_id: 'exec-patch-1',
        output:
          'Script completed\nWall time 0.2 seconds\nOutput:\n' +
          'Success. Updated the following files:\nM src/example.ts',
      },
    })

    expect(entries).toHaveLength(1)
    const entry = entries[0]
    expect(entry?.type).toBe('user')
    if (!entry || !isConversationEntry(entry) || !Array.isArray(entry.message.content)) {
      throw new Error('expected a tool-result conversation entry')
    }
    expect(entry.message.content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'exec-patch-1',
      is_error: false,
      content: 'Success. Updated the following files:\nM src/example.ts',
    })
  })
})
