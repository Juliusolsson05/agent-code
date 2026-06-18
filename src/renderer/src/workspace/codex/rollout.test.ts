import { describe, expect, it } from 'vitest'

import { mapCodexRolloutToFeedEntries } from '@renderer/workspace/codex/rollout'

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
})
