import type { ReactNode } from 'react'

import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'
import {
  CodexApplyPatchRow,
  CodexExecCommandRow,
  CodexToolResultRow,
  CodexToolRow,
  CodexWriteStdinRow,
} from '@providers/codex/renderer/rows/CodexRows'

export function renderCodexToolUse(block: ToolUseBlock): ReactNode | undefined {
  // WHY Codex falls back to CodexToolRow here instead of shared ToolUseRow:
  // the Codex row understands Codex's function-call payload conventions and
  // has provider-specific headline extraction for arguments/raw patches. The
  // shared fallback remains for providers that do not claim a tool name.
  if (block.name === 'apply_patch') return <CodexApplyPatchRow block={block} />
  if (block.name === 'exec_command') return <CodexExecCommandRow block={block} />
  if (block.name === 'write_stdin') return <CodexWriteStdinRow block={block} />
  return <CodexToolRow block={block} />
}

export function renderCodexToolResult(
  block: ToolResultBlock,
  context: { sourceTool?: ToolUseBlock | null },
): ReactNode | undefined {
  if (context.sourceTool?.name === 'spawn_agent') {
    // Codex's spawn_agent result is the renderer join payload
    // ({agent_id,nickname}), not the child agent's work. Once the spawn call
    // renders as a TaskSubagentRow, showing that raw JSON below it is both
    // noisy and misleading; wait_agent and child notifications carry the
    // user-relevant completion state instead.
    return null
  }
  return <CodexToolResultRow block={block} />
}
