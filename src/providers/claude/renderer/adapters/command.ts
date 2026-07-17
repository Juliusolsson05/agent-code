import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'
import { analyzeCommandOutput } from '@providers/shared/renderer/protocols/command/formatters/index'
import type { CommandRenderModel } from '@providers/shared/renderer/protocols/command/model'
import type { CodeEditRenderModel } from '@providers/shared/renderer/protocols/code-edit/model'
import {
  extractShellHeredocWrite,
  shellHeredocWriteModel,
} from '@providers/shared/renderer/protocols/command/shellFileWrite'
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
  opts: { streaming?: boolean; running?: boolean; failed?: boolean; errorSummary?: string } = {},
): CommandRenderModel | null {
  if (block.name !== 'Bash') return null
  const input = (block.input ?? {}) as Record<string, unknown>
  const command = typeof input.command === 'string' ? input.command : ''
  if (!/\S/.test(command) && !opts.streaming) return null // caller falls through
  return {
    label: 'Bash',
    command: boundCommand(command),
    status: opts.failed
      ? 'failure'
      : opts.streaming
        ? 'streaming'
        : opts.running
          ? 'running'
          : 'success',
    exitCode: null, // Claude reports failure via the paired result's is_error
    errorSummary: opts.errorSummary,
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

// ── Heredoc file-writes rendered as REAL writes, not command headlines ──
//
// Product-owner verdict (2026-07-17): `cat > path <<'EOF' … EOF` was showing
// a squashed command line with the written CONTENT invisible. When the shared
// extractor recognizes the quoted-delimiter cat-heredoc shape (its strict
// contract lives in shellFileWrite.ts), Bash routes into the code-edit
// protocol instead — a green additions card. Dispatch tries this FIRST and
// only falls back to the command card when it declines, so every other Bash
// command is completely unaffected.
//
// CRITICAL: feed the extractor the FULL command, never boundCommand()'s
// 160-char headline — the body lives past that cap.

export function fromClaudeBashCodeEdit(
  block: ToolUseBlock,
  opts: { streaming?: boolean; running?: boolean; failed?: boolean; errorSummary?: string } = {},
): CodeEditRenderModel | null {
  if (block.name !== 'Bash') return null
  const input = (block.input ?? {}) as Record<string, unknown>
  const command = typeof input.command === 'string' ? input.command : ''
  const write = extractShellHeredocWrite(command)
  if (!write) return null
  const model = shellHeredocWriteModel(write, { streaming: opts.streaming === true, label: 'Bash' })
  return {
    ...model,
    status: opts.failed
      ? 'failure'
      : opts.streaming
        ? 'streaming'
        : opts.running
          ? 'running'
          : 'success',
    errorSummary: opts.errorSummary,
  }
}

/** STREAMING-FIRST partial variant: the heredoc parse is trustworthy the
 *  moment the command's FIRST LINE closes, long before the whole JSON lands —
 *  content lines then grow in place. extractJsonStringField hands us the
 *  full (possibly still-open) command value; the extractor itself refuses
 *  until the first newline arrives. */
export function fromClaudePartialBashCodeEdit(rawInputJson: string): CodeEditRenderModel | null {
  const cmd = extractJsonStringField(rawInputJson, 'command')
  if (!cmd) return null
  const write = extractShellHeredocWrite(cmd.value)
  if (!write) return null
  // Still streaming until the FULL JSON has closed the command token AND the
  // heredoc terminator has arrived; either gap means more content may follow.
  const streaming = !cmd.closed || !write.complete
  return shellHeredocWriteModel(write, { streaming, label: 'Bash' })
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
