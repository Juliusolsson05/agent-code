import { memo, type ReactNode } from 'react'

import type { ToolResultBlock } from '@shared/types/transcript'
import { asRecord } from '@shared/lib/asRecord'

import { Base64MediaView } from '@providers/shared/renderer/protocols/media/Base64MediaView'
import { parseBase64MediaPreview } from '@providers/shared/renderer/protocols/media/base64'

// Ordered rendering for a tool result that mixes text and media.
//
// WHY this is shared rather than living in the feed's ToolResultRow
// -----------------------------------------------------------------
// The first version of this change put the media branch only in the generic
// `ToolResultRow`, and review proved that the REPORTED bug never reaches it:
// a Codex `exec` result is claimed by `renderCodexToolResult`
// (codex/renderer/rows/dispatch.tsx) because its correlated call is named
// `exec` and its envelope is `custom_tool_call_output`, so it renders through
// `CodexToolResultRow` instead. The fix removed the megabyte dump but the
// images still did not paint on the exact path that produced the screenshot.
//
// Two painters need the same behaviour, so the behaviour lives in one place
// that both call. Duplicating it into each would recreate the two-owners shape
// this whole change exists to remove.
//
// WHY it takes `renderText` instead of choosing a text presentation
// ------------------------------------------------------------------
// The two callers legitimately paint text differently — the feed uses
// `TruncatedOutputRow` with its paging, the Codex card uses `OutputWell` with
// ANSI handling. This component owns ORDER and MEDIA, which is the part that
// must agree; it deliberately does not own how a caller draws a line of text.
//
// WHY no MarkerRow: an earlier version reused `ImageBlockRow`, which stamps the
// assistant marker `⏺`. Interleaved with `⎿` output rows that reads as
// `⎿ path / ⏺ image / ⎿ path / ⏺ image` — the image appears to be a new
// assistant turn rather than part of the result it belongs to.

type Part = { type: string; text?: string; [key: string]: unknown }

/**
 * True when this content carries at least one part we can actually paint.
 *
 * WHY it demands a base64 `source` envelope rather than `type === 'image'`:
 * the looser test stole MCP results. MCP's own `ImageContent` is flat —
 * `{type:'image', mimeType, data}` with no `source` — and `McpContentView`
 * already renders it inline alongside `isError`, `structuredContent`, `_meta`,
 * and `resource_link` siblings. A bare type check made this component claim
 * those results and drop everything except a "View unsupported image source"
 * disclosure. Requiring the envelope we know how to paint leaves MCP with its
 * own, better presenter.
 */
export function hasRenderableMedia(
  content: ToolResultBlock['content'],
): content is Part[] {
  return (
    Array.isArray(content) &&
    content.some(part => {
      if (asRecord(part)?.type !== 'image') return false
      return asRecord(asRecord(part)?.source)?.type === 'base64'
    })
  )
}

export const ResultParts = memo(function ResultParts({
  parts,
  renderText,
}: {
  parts: Part[]
  renderText: (text: string, key: string) => ReactNode
}) {
  return (
    <div className="min-w-0 space-y-1">
      {parts.map((part, index) => {
        if (part.type === 'image') {
          const source = asRecord(part.source)
          const media = parseBase64MediaPreview(
            'image',
            source?.media_type ?? source?.mimeType,
            source?.data,
          )
          const label = media?.mimeType ?? 'image'
          return (
            <Base64MediaView
              // Index keys are correct here and only here: a committed tool
              // result is immutable once written, so a part can never be
              // reordered, inserted, or removed within it, and the wire parts
              // carry no id of their own.
              key={`media-${index}`}
              model={media}
              label={label}
              alt="Tool result image"
            />
          )
        }
        const text = typeof part.text === 'string' ? part.text : ''
        if (!text.trim()) return null
        return renderText(text, `text-${index}`)
      })}
    </div>
  )
})
