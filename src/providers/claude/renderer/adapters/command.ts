import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'
import { analyzeCommandOutput } from '@providers/shared/renderer/protocols/command/formatters/index'
import type { CommandRenderModel } from '@providers/shared/renderer/protocols/command/model'
import { extractJsonStringField } from '@providers/claude/renderer/adapters/codeEdit'

// Claude wire → CommandRenderModel (PR #555 Phase 6). Claude-PRIVATE:
// parses Bash's {command, description, timeout, run_in_background} input
// vocabulary. Output pairing note: Claude delivers command output as a
// SEPARATE tool_result block, so the committed plane renders a header card
// from the tool_use (this adapter) and an output row from the result
// (fromClaudeBashResult) — the same two-row shape users already know, both
// upgraded to the shared grammar.

const COMMAND_DISPLAY_CAP = 160

function boundCommand(command: string): string {
  const firstLines = command.split('\n').slice(0, 2).join('\n')
  return firstLines.length > COMMAND_DISPLAY_CAP
    ? `${firstLines.slice(0, COMMAND_DISPLAY_CAP)}…`
    : firstLines.length < command.length
      ? `${firstLines}…`
      : firstLines
}

export function fromClaudeBashBlock(
  block: ToolUseBlock,
  opts: { streaming?: boolean } = {},
): CommandRenderModel | null {
  if (block.name !== 'Bash') return null
  const input = (block.input ?? {}) as Record<string, unknown>
  const command = typeof input.command === 'string' ? input.command : ''
  if (!/\S/.test(command) && !opts.streaming) return null // caller falls through
  return {
    label: 'Bash',
    command: boundCommand(command),
    status: opts.streaming ? 'streaming' : 'success',
    exitCode: null, // Claude reports failure via the paired result's is_error
    // output arrives on the SEPARATE result row — undefined by design here.
  }
}

/** STREAMING-FIRST: raw partial input JSON → model the moment `command`
 *  CLOSES (a half-streamed command must not paint as the headline). */
export function fromClaudePartialBashJson(rawInputJson: string): CommandRenderModel | null {
  const cmd = extractJsonStringField(rawInputJson, 'command')
  if (!cmd || !cmd.closed) return null
  return {
    label: 'Bash',
    command: boundCommand(cmd.value),
    status: 'streaming',
    exitCode: null,
  }
}

export function claudeBashResultText(result: ToolResultBlock): string {
  const c = result.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    return c
      .map(item =>
        typeof item === 'string'
          ? item
          : typeof (item as { text?: unknown })?.text === 'string'
            ? String((item as { text: string }).text)
            : '',
      )
      .join('\n')
  }
  return ''
}

export function claudeBashConclusion(result: ToolResultBlock, command: string): string | null {
  // TERMINAL only by construction — a committed tool_result IS terminal.
  return analyzeCommandOutput(command, claudeBashResultText(result), null)
}
