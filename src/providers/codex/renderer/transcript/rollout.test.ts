import { describe, expect, it } from 'vitest'

import { mapCodexRolloutToFeedEntries } from '@providers/codex/renderer/transcript/rollout'

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
  it('preserves successful silent command completion as terminal evidence', () => {
    const entries = mapCodexRolloutToFeedEntries({
      type: 'event_msg',
      timestamp: '2026-06-18T11:12:01.000Z',
      payload: {
        type: 'exec_command_end',
        call_id: 'silent-command',
        aggregated_output: '',
        exit_code: 0,
        status: 'completed',
      },
    })

    // WHY the empty content is intentional: correlation needs the result
    // block's existence, not fabricated output text. The operation renderer
    // consumes this evidence into the command card and absorbs the otherwise
    // blank result row.
    expect(entries).toHaveLength(1)
    const entry = entries[0] as {
      message?: { content?: Array<Record<string, unknown>> }
    }
    expect(entry.message?.content?.[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'silent-command',
      content: '',
      is_error: false,
      codex: { kind: 'exec_command_end', exitCode: 0 },
    })
  })

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
            // Real wrapper shape (codex-rs user_instructions.rs): the old
            // `<INSTRUCTIONS />` literal was never something Codex writes.
            text: '# AGENTS.md instructions for /Users/julius/project\n\n<INSTRUCTIONS>\nproject rules\n</INSTRUCTIONS>',
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

  // Recorded shape: debug bundle 2026-10-27T17-09-56 (Codex 0.164.0 rollout
  // 01a1793b…, line 8). With a global ~/.codex/AGENTS.md Codex writes the
  // header WITHOUT ` for <dir>` (UserInstructions.directory = None in
  // codex-rs/core/src/context/user_instructions.rs); 26 of 44 AGENTS.md
  // preambles in the local corpus are this bare form. Body trimmed to its
  // first real line; the wrapper bytes are verbatim.
  it('drops the bare (directory-less) AGENTS.md preamble Codex writes for global instructions', () => {
    const entries = mapCodexRolloutToFeedEntries({
      type: 'response_item',
      timestamp: '2026-10-26T17:21:31.543Z',
      payload: {
        type: 'message',
        id: 'msg_bootstrap_bare',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: '# AGENTS.md instructions\n\n<INSTRUCTIONS>\n<!-- AUTONOMY DIRECTIVE — DO NOT REMOVE -->\n</INSTRUCTIONS>',
          },
          {
            type: 'input_text',
            text: '<environment_context>\n  <cwd>/Users/julius/project</cwd>\n  <shell>zsh</shell>\n</environment_context>',
          },
        ],
      },
    })

    expect(entries).toEqual([])
  })

  it('keeps a real prompt that merely starts with the AGENTS.md heading', () => {
    const entries = mapCodexRolloutToFeedEntries(
      userMessage('# AGENTS.md instructions\n\nwhy does Codex inject these twice?'),
    )

    expect(entries).toHaveLength(1)
    expect(entries[0]?.type).toBe('user')
  })

  // Both halves of the marker pair are load-bearing (review A, #1538): the end
  // marker alone would hide a pasted <INSTRUCTIONS> block, and an unanchored
  // end would hide a prompt that keeps going after the quoted block.
  it.each([
    'fix this:\n<INSTRUCTIONS>\nold rules\n</INSTRUCTIONS>',
    '# AGENTS.md instructions\n\n<INSTRUCTIONS>\nold rules\n</INSTRUCTIONS>\n\nwhy are these ignored?',
  ])('keeps a real prompt that only partly matches the preamble markers: %s', text => {
    const entries = mapCodexRolloutToFeedEntries(userMessage(text))

    expect(entries).toHaveLength(1)
    expect(entries[0]?.type).toBe('user')
  })

  it('preserves find-in-page pattern for live/committed web convergence', () => {
    const entries = mapCodexRolloutToFeedEntries({
      type: 'response_item',
      timestamp: '2026-06-18T11:12:00.000Z',
      payload: {
        type: 'web_search_call',
        id: 'web-find-1',
        status: 'completed',
        action: {
          type: 'find_in_page',
          url: 'https://example.com/docs',
          pattern: 'provider-owned',
        },
      },
    })

    expect(entries).toHaveLength(1)
    const entry = entries[0] as { message?: { content?: Array<{ input?: unknown }> } }
    expect(entry.message?.content?.[0]?.input).toMatchObject({
      kind: 'find_in_page',
      url: 'https://example.com/docs',
      pattern: 'provider-owned',
      status: 'completed',
    })
  })

  it('normalizes image generation as provider lifecycle plus lazy shared image content', () => {
    const entries = mapCodexRolloutToFeedEntries({
      type: 'response_item',
      timestamp: '2026-06-18T11:12:00.000Z',
      payload: {
        type: 'image_generation_call',
        id: 'image-1',
        status: 'completed',
        revised_prompt: 'A small blue lighthouse',
        result: 'YWJj',
      },
    })

    expect(entries).toHaveLength(1)
    const entry = entries[0] as { message?: { content?: Array<Record<string, unknown>> } }
    expect(entry.message?.content?.[0]).toMatchObject({
      type: 'tool_use',
      id: 'image-1',
      name: 'image_generation',
      input: { status: 'completed', revisedPrompt: 'A small blue lighthouse' },
    })
    expect(entry.message?.content?.[1]).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'YWJj' },
    })
  })
})
