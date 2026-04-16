import type { Entry, ToolResultBlock, ToolUseBlock } from '../../../src/shared/types/transcript'

export type RenderingFixture = {
  id: string
  title: string
  provider: 'claude' | 'codex'
  description: string
  entries: Entry[]
  streamingScreenMarkdown?: string
  streamingBaseline?: string
  activityStatus?: string
}

function toolUse(
  id: string,
  name: string,
  input: Record<string, unknown>,
): ToolUseBlock {
  return { type: 'tool_use', id, name, input }
}

function toolResult(
  tool_use_id: string,
  content: string,
): ToolResultBlock {
  return { type: 'tool_result', tool_use_id, content }
}

export const RENDERING_FIXTURES: RenderingFixture[] = [
  {
    id: 'claude-mixed',
    title: 'Claude Mixed Transcript',
    provider: 'claude',
    description: 'User prompt, assistant markdown, tool rows, and fenced code.',
    entries: [
      {
        type: 'user',
        uuid: 'claude-user-1',
        parentUuid: null,
        timestamp: '2026-04-16T10:01:00.000Z',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Check the failing renderer build and show me the issue.' }],
        },
      },
      {
        type: 'assistant',
        uuid: 'claude-assistant-1',
        parentUuid: 'claude-user-1',
        timestamp: '2026-04-16T10:01:04.000Z',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: [
                'I found one concrete issue in the build path.',
                '',
                '```ts',
                'const target = resolve(config.root, input)',
                'if (!existsSync(target)) throw new Error(\"missing\")',
                '```',
              ].join('\n'),
            },
            toolUse('claude-bash-1', 'Bash', {
              command: 'npm exec tsc -- --noEmit',
              description: 'Verify renderer build output',
            }),
          ],
        },
      },
      {
        type: 'user',
        uuid: 'claude-user-2',
        parentUuid: 'claude-assistant-1',
        timestamp: '2026-04-16T10:01:06.000Z',
        message: {
          role: 'user',
          content: [toolResult('claude-bash-1', 'src/renderer/src/App.tsx(42,7): error TS6133: value is never read.')],
        },
      },
      {
        type: 'assistant',
        uuid: 'claude-assistant-2',
        parentUuid: 'claude-user-2',
        timestamp: '2026-04-16T10:01:10.000Z',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: 'The error is a dead local. Remove it or thread it into the render path.',
            },
          ],
        },
      },
    ],
  },
  {
    id: 'codex-compacted',
    title: 'Codex Compacted Session',
    provider: 'codex',
    description: 'Compact boundary, summary, reconstructed turns, and post-compact answer.',
    entries: [
      {
        type: 'system',
        subtype: 'compact_boundary',
        content: 'Conversation compacted',
        uuid: 'codex-compact-boundary',
      },
      {
        type: 'user',
        uuid: 'codex-compact-summary',
        parentUuid: null,
        timestamp: '2026-04-16T11:30:00.000Z',
        isCompactSummary: true,
        isVisibleInTranscriptOnly: true,
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Summary: renderer work focused on compaction handling and prompt-history correctness.' }],
        },
      },
      {
        type: 'user',
        uuid: 'codex-replacement-user-1',
        parentUuid: null,
        timestamp: '2026-04-16T11:30:01.000Z',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Add a compact-aware transcript mapping for Codex.' }],
        },
      },
      {
        type: 'assistant',
        uuid: 'codex-replacement-assistant-1',
        parentUuid: 'codex-replacement-user-1',
        timestamp: '2026-04-16T11:30:03.000Z',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: 'Mapped `compacted` rollout lines into boundary, summary, and replacement history entries.',
            },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'codex-user-2',
        parentUuid: 'codex-replacement-assistant-1',
        timestamp: '2026-04-16T11:30:07.000Z',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Now give me the latest user prompts in a modal.' }],
        },
      },
      {
        type: 'assistant',
        uuid: 'codex-assistant-2',
        parentUuid: 'codex-user-2',
        timestamp: '2026-04-16T11:30:10.000Z',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: 'Added a command-driven modal that shows the latest visible prompts with timestamps.',
            },
            toolUse('codex-tool-1', 'exec_command', {
              cmd: 'npm exec tsc -- --noEmit',
            }),
          ],
        },
      },
      {
        type: 'user',
        uuid: 'codex-user-3',
        parentUuid: 'codex-assistant-2',
        timestamp: '2026-04-16T11:30:12.000Z',
        message: {
          role: 'user',
          content: [toolResult('codex-tool-1', 'TypeScript finished with 0 errors.')],
        },
      },
    ],
  },
  {
    id: 'streaming-preview',
    title: 'Streaming Preview',
    provider: 'claude',
    description: 'Assistant streaming markdown with no completed transcript entry yet.',
    entries: [
      {
        type: 'user',
        uuid: 'stream-user-1',
        parentUuid: null,
        timestamp: '2026-04-16T12:00:00.000Z',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Summarize what changed in the renderer.' }],
        },
      },
    ],
    streamingBaseline: 'Summarize what changed in the renderer.',
    streamingScreenMarkdown: [
      'I changed three areas:',
      '',
      '1. Compaction entries now render correctly.',
      '2. Prompt history is shared and filter-safe.',
      '3. A dedicated prompt modal was added.',
    ].join('\n'),
    activityStatus: 'Thinking',
  },
]
