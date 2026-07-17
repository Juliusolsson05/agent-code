import type { ReactNode } from 'react'

import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'
import { renderOpencodeReadResult } from '@providers/opencode/renderer/components/read-result'
import { fromOpencodeTodoUse } from '@providers/opencode/renderer/adapters/todo'
import { OpencodeTodoRow } from '@providers/opencode/renderer/components/todo'

// OpenCode committed/live tool rows.
//
// Everything else (read/glob/bash/task/…) intentionally falls through to the
// generic ToolUseRow/ToolResultRow: the probe showed their inputs/results
// are plain path/pattern/command payloads the generic rows present fine.
// Specialized rows (diff-style edit rendering etc.) should be added here one
// evidence-backed tool at a time, not speculatively.
export function renderOpencodeToolUse(block: ToolUseBlock): ReactNode | undefined {
  const todo = fromOpencodeTodoUse(block)
  return todo ? <OpencodeTodoRow model={todo} /> : undefined
}

export function renderOpencodeToolResult(
  block: ToolResultBlock,
  context: { sourceTool?: ToolUseBlock | null },
): ReactNode | undefined {
  const source = context.sourceTool?.name
  // TODO(phase-7-opencode-todo-result): capture a durable paired result and
  // add a parse-fully-or-decline adapter before absorbing any todowrite echo.
  // The only retained evidence proves the invocation schema, not that every
  // success/error result repeats the checklist. A name-only null here used to
  // delete drifted and failed results; the shared structured fallback is the
  // honest owner until the result grammar itself is proven.
  // read results are a tagged text document (<path>/<type>/<content>
  // soup). Parse and present as a code slab with the real path; fall
  // through to the generic row when the shape doesn't match.
  if (source === 'read') {
    const row = renderOpencodeReadResult(block)
    if (row !== undefined) return row
  }
  return undefined
}
