import type { ReactNode } from 'react'

import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'

export function renderClaudeToolUse(block: ToolUseBlock): ReactNode | undefined {
  // WHY this dispatch lives with the provider rows: these names are Claude Code
  // transcript vocabulary, not feed vocabulary. Keeping the table beside the
  // row components makes adding/removing a Claude tool a provider-local change
  // and lets the shared feed keep one generic fallback for unknown tools.
  // Edit / MultiEdit / Write / TodoWrite no longer route here: their
  // families are intercepted upstream in Block.tsx (routeFamily →
  // DiffCard / FileWriteCard / TodoCard). Nothing Claude-specific
  // remains — kept as an explicit empty seam until the capability
  // table drops renderToolUse entirely (phase-5 deletion task).
  void block
  return undefined
}

export function renderClaudeToolResult(
  _block: ToolResultBlock,
): ReactNode | undefined {
  return undefined
}
