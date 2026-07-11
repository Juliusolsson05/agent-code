import { memo, useContext } from 'react'

import type { ToolResultBlock } from '@shared/types/transcript'

import { ToolUseIndexContext } from '@renderer/features/feed/context'

import { JsonResultSlab } from '@providers/shared/renderer/rows/JsonResultSlab'
import { tryExtractJson } from '@providers/shared/renderer/rows/jsonToolPresentation'
import { OutputWell } from '@renderer/features/feed/ui/kit/OutputWell'

/* ---------- Tool result: "⎿  (lines of output)" ---------- */

/**
 * Generic tool-result renderer — the LEGACY fallback for families whose
 * dedicated card hasn't landed (web, image-gen) and for results whose
 * source tool the index can't resolve. Everything else is suppressed
 * upstream in Block.tsx and rendered inside its family card.
 */
export const ToolResultRow = memo(function ToolResultRow({
  block,
}: {
  block: ToolResultBlock
}) {
  const toolUseIndex = useContext(ToolUseIndexContext)
  const sourceTool = toolUseIndex.get(block.tool_use_id)?.name

  const text =
    typeof block.content === 'string'
      ? block.content
      : Array.isArray(block.content)
        ? block.content
            .map(c => (typeof c === 'string' ? c : c.text ?? ''))
            .join('\n')
        : String(block.content)

  const isError = block.is_error === true
  const trimmed = text.replace(/\s+$/, '')

  // NOTE: the Read and Grep special branches that lived here are GONE
  // on purpose — the file-read family is suppressed upstream in
  // Block.tsx and rendered by ReadCard (one card owns both halves).

  // JSON-shaped results (MCP envelope / plain JSON) get a collapsed
  // pretty rendering instead of an escaped one-liner (residue plan P1).
  // tryExtractJson returns null for anything not JSON-shaped, so this
  // can never make a result LESS readable than the truncation below.
  const parsedJson = tryExtractJson(trimmed)
  if (parsedJson !== null && typeof parsedJson === 'object') {
    return <JsonResultSlab value={parsedJson} isError={isError} />
  }

  // Everything else — Bash, Glob, LS, tool errors — truncates to the
  // first few lines and offers a click-to-expand for the rest. Mirrors
  // claude-code's OutputLine + renderTruncatedContent (MAX_LINES_TO_SHOW
  // = 3). The collapsed view keeps the feed dense so a long `find .`
  // or noisy test run doesn't push the assistant's next message off.
  // OutputWell is the kit successor — same behavior, ANSI-aware.
  return <OutputWell text={trimmed} isError={isError} ansi />
})
