import type { ReactNode } from 'react'

import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'
import { TodoRow } from '@providers/shared/renderer/rows/TodoRow'
import { renderOpencodeReadResult } from '@providers/opencode/renderer/rows/OpencodeReadResult'

// OpenCode committed/live tool rows.
//
// WHY this reuses the SHARED TodoRow instead of cloning it: the live probe
// of a real opencode 1.15.2 session (2026-07-06, /tmp/oc-probe-events.jsonl)
// captured todowrite's finalized input as
//   { todos: [{ content, status, priority }] }
// — a compatible subset of what TodoRow's parseTodos already handles
// defensively (activeForm simply renders empty, priority is ignored). The
// `label` prop keeps the row header honest about which tool the agent
// actually called. The row moved from Claude's directory to
// providers/shared (Phase 1, evidence-first rendering plan) because a
// provider importing another provider's rows is the exact coupling the
// import-boundary rules forbid. If opencode's todo shape ever diverges,
// clone the row into THIS directory rather than growing provider branches
// inside the shared row.
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
  block: ToolResultBlock,
  context: { sourceTool?: ToolUseBlock | null },
): ReactNode | undefined {
  const source = context.sourceTool?.name
  // todowrite results echo the JSON checklist that TodoRow ALREADY
  // rendered from the tool_use above — painting it again is the raw-blob
  // noise the 07-06 bundle shows. State lives in the row; drop the echo.
  if (source === 'todowrite') return null
  // read results are a tagged text document (<path>/<type>/<content>
  // soup). Parse and present as a code slab with the real path; fall
  // through to the generic row when the shape doesn't match.
  if (source === 'read') {
    const row = renderOpencodeReadResult(block)
    if (row !== undefined) return row
  }
  return undefined
}
