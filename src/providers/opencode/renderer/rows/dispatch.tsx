import type { ReactNode } from 'react'

import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'
import { TodoRow } from '@providers/claude/renderer/rows/ClaudeRows'

// OpenCode committed/live tool rows.
//
// WHY this reuses Claude's TodoRow instead of cloning it: the live probe of
// a real opencode 1.15.2 session (2026-07-06, /tmp/oc-probe-events.jsonl)
// captured todowrite's finalized input as
//   { todos: [{ content, status, priority }] }
// — a compatible subset of what TodoRow's parseTodos already handles
// defensively (activeForm simply renders empty, priority is ignored). The
// `label` prop keeps the row header honest about which tool the agent
// actually called. If opencode's todo shape ever diverges, THIS is the seam
// to fork at — clone the row into this directory rather than growing
// provider branches inside ClaudeRows.
//
// Everything else (read/glob/bash/task/…) intentionally falls through to the
// generic ToolUseRow/ToolResultRow: the probe showed their inputs/results
// are plain path/pattern/command payloads the generic rows present fine.
// Specialized rows (diff-style edit rendering etc.) should be added here one
// evidence-backed tool at a time, not speculatively.
export function renderOpencodeToolUse(block: ToolUseBlock): ReactNode | undefined {
  switch (block.name) {
    case 'todowrite':
      return <TodoRow block={block} label="todowrite" />
    default:
      return undefined
  }
}

export function renderOpencodeToolResult(
  _block: ToolResultBlock,
): ReactNode | undefined {
  // No opencode-specific result rows yet; generic ToolResultRow presents
  // read/glob/bash results acceptably (the read result is a tagged text
  // document the generic row shows verbatim).
  return undefined
}
