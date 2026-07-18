import { memo, useMemo } from 'react'

import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'

import { JsonResultSlab } from '@providers/shared/renderer/rows/JsonResultSlab'
import { tryExtractJson } from '@providers/shared/renderer/rows/jsonToolPresentation'
import { StructuredOutputView } from '@providers/shared/renderer/protocols/structured-output/StructuredOutputView'
import { parseStructuredOutput } from '@providers/shared/renderer/protocols/structured-output/model'
import { McpContentView } from '@providers/shared/renderer/protocols/mcp-content/McpContentView'
import {
  isMcpContentCarrier,
  parseMcpContentResult,
} from '@providers/shared/renderer/protocols/mcp-content/model'
import { TruncatedOutputRow } from '@renderer/features/feed/ui/rows/TruncatedOutputRow'
import { TEXT_PAGE_MAX_CHARS } from '@renderer/lib/text/boundedText'
import { toolResultContentText } from '@providers/shared/renderer/rows/toolResultContent'

/* ---------- Tool result: "⎿  (lines of output)" ---------- */

const GenericToolResultPresentation = memo(function GenericToolResultPresentation({
  content,
  sourceTool,
  text,
  isError,
}: {
  content: ToolResultBlock['content']
  sourceTool?: string
  text: string
  isError: boolean
}) {
  // WHY parse only after provider/read/search specializations decline and
  // memoize by durable input: committed results re-render when feed index
  // contexts change identity. Re-running up to three bounded scans across
  // every historical result on each append recreated the renderer GC churn
  // this rewrite is intended to remove.
  const presentation = useMemo(() => {
    const json = tryExtractJson(text)
    const directMcp = sourceTool?.startsWith('mcp__') === true
      ? parseMcpContentResult(content, { allowDirectArray: true })
      : null
    const serializedMcp = parseMcpContentResult(text)
    const jsonIsCarrier = isMcpContentCarrier(json)
    const mcp = json !== null && !jsonIsCarrier && directMcp === null
      ? null
      : directMcp ?? (serializedMcp && jsonIsCarrier ? serializedMcp : null)
    return {
      json,
      mcp,
      structured: mcp !== null || (json !== null && typeof json === 'object')
        ? null
        : parseStructuredOutput(text),
    }
  }, [content, sourceTool, text])

  if (presentation.mcp !== null) {
    return (
      <McpContentView
        model={presentation.mcp}
        source={typeof content === 'string' ? text : undefined}
        transportError={isError}
      />
    )
  }
  if (presentation.json !== null && typeof presentation.json === 'object') {
    return <JsonResultSlab value={presentation.json} isError={isError} source={text} />
  }
  if (presentation.structured !== null) {
    return (
      <StructuredOutputView
        model={presentation.structured}
        source={text}
        isError={isError}
      />
    )
  }
  return <TruncatedOutputRow content={text} isError={isError} />
})

/**
 * Canonical provider-neutral result fallback. Provider dispatch gets first
 * refusal in Block; reaching this component means no provider adapter proved
 * a more specific grammar. It may format JSON, MCP content, structured text,
 * or bounded plain output, but it must never branch on provider tool names.
 */
export const ToolResultRow = memo(function ToolResultRow({
  block,
  sourceTool,
}: {
  block: ToolResultBlock
  sourceTool?: ToolUseBlock | null
}) {
  const text = toolResultContentText(block.content)

  const isError = block.is_error === true
  // WHY giant output skips eager trim: trim creates another near-complete
  // string before the paged viewer can discard almost all of it. Small output
  // preserves the historical whitespace cleanup; large output stays as the
  // durable source and each admitted page handles its own presentation.
  const trimmed = text.length <= TEXT_PAGE_MAX_CHARS
    ? text.replace(/\s+$/, '')
    : text

  return (
    <GenericToolResultPresentation
      content={block.content}
      sourceTool={sourceTool?.name}
      text={trimmed}
      isError={isError}
    />
  )
})
