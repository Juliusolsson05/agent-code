import { memo, useMemo } from 'react'

import type { ContentBlock, ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'

import { ImageBlockRow } from '@renderer/features/feed/ui/rows/ImageBlockRow'

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
/**
 * True when the mapping boundary already decided this result contains media.
 *
 * WHY this is a structural check and not a call to `recognizeImageNode`: the
 * recognizer has exactly one consumer — the transcript-mapping boundary — and
 * feed components are on its forbidden-importer list
 * (docs/decomposition/image-read-base64-dump.md). By the time content reaches a
 * painter it has already been normalized to the neutral `image` block, so
 * dispatching on the discriminator here is *reading* an ownership decision
 * rather than making a second one. Re-recognizing in the painter is how the
 * distributed-ownership bug class grows back.
 */
function hasMediaParts(
  content: ToolResultBlock['content'],
): content is Array<{ type: string; text?: string; [key: string]: unknown }> {
  return Array.isArray(content) && content.some(part => part?.type === 'image')
}

/**
 * Render a heterogeneous result as ordered parts.
 *
 * The ordering is the whole point. Codex `exec` returns text(path), image,
 * text(path), image — the text parts are the filenames labelling each image, so
 * rendering images in a separate group below the text (or flattening to a
 * string) leaves orphaned paths above unlabelled pictures.
 */
const ToolResultParts = memo(function ToolResultParts({
  parts,
  isError,
}: {
  parts: Array<{ type: string; text?: string; [key: string]: unknown }>
  isError: boolean
}) {
  return (
    <div className="min-w-0 space-y-1">
      {parts.map((part, index) => {
        if (part.type === 'image') {
          return (
            <ImageBlockRow
              // Index keys are correct here and only here: a committed tool
              // result is immutable once written, so a part can never be
              // reordered, inserted, or removed within it. There is no stabler
              // identity available — the wire parts carry no id.
              key={`image-${index}`}
              block={part as ContentBlock}
              role="assistant"
            />
          )
        }
        const text = typeof part.text === 'string' ? part.text : ''
        if (!text.trim()) return null
        return <TruncatedOutputRow key={`text-${index}`} content={text} isError={isError} />
      })}
    </div>
  )
})

export const ToolResultRow = memo(function ToolResultRow({
  block,
  sourceTool,
}: {
  block: ToolResultBlock
  sourceTool?: ToolUseBlock | null
}) {
  // Checked before flattening. `toolResultContentText` now projects an image to
  // a bytes-free `[image/jpeg]` label rather than 512 characters of base64, so
  // reaching the text path is no longer a correctness bug — but it would still
  // throw away the picture the user asked to see.
  if (hasMediaParts(block.content)) {
    return <ToolResultParts parts={block.content} isError={block.is_error === true} />
  }

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
