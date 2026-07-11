import type { ReactNode } from 'react'

import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'
import { TodoRow } from '@providers/claude/renderer/rows/ClaudeRows'

export function renderClaudeToolUse(block: ToolUseBlock): ReactNode | undefined {
  // WHY this dispatch lives with the provider rows: these names are Claude Code
  // transcript vocabulary, not feed vocabulary. Keeping the table beside the
  // row components makes adding/removing a Claude tool a provider-local change
  // and lets the shared feed keep one generic fallback for unknown tools.
  switch (block.name) {
    // Edit / MultiEdit / Write no longer route here: the file-edit and
    // file-write families are intercepted upstream in Block.tsx
    // (routeFamily → DiffCard / FileWriteCard).
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
