import type { ReactNode } from 'react'

import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'
import {
  TodoRow,
  WriteRow,
} from '@providers/claude/renderer/rows/ClaudeRows'

export function renderClaudeToolUse(block: ToolUseBlock): ReactNode | undefined {
  // WHY this dispatch lives with the provider rows: these names are Claude Code
  // transcript vocabulary, not feed vocabulary. Keeping the table beside the
  // row components makes adding/removing a Claude tool a provider-local change
  // and lets the shared feed keep one generic fallback for unknown tools.
  switch (block.name) {
    // Edit / MultiEdit no longer route here: the file-edit family is
    // intercepted upstream in Block.tsx (routeFamily → DiffCard).
    case 'Write':
      return <WriteRow block={block} />
    case 'TodoWrite':
      return <TodoRow block={block} />
    default:
      return undefined
  }
}

export function renderClaudeToolResult(
  _block: ToolResultBlock,
): ReactNode | undefined {
  return undefined
}
