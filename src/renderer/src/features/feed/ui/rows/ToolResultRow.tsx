import { memo, useContext, useMemo, useState, type ReactNode } from 'react'

import type { ToolResultBlock } from '@shared/types/transcript'

import { CodeBlock } from '@renderer/lib/code/CodeBlock'

import { stripLineNumberPrefix } from '@renderer/features/feed/lib/helpers'
import { CodeRenderContext, ToolUseIndexContext } from '@renderer/features/feed/context'
import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'

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
import { boundedTextLineCount, TEXT_PAGE_MAX_CHARS } from '@renderer/lib/text/boundedText'

/* ---------- Tool result: "⎿  (lines of output)" ---------- */

function LazyDetails({
  summary,
  children,
}: {
  summary: ReactNode
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    // WHY close unmounts rather than latching after first-open: an old session
    // can contain hundreds of once-inspected reads. A latch turns interaction
    // history into permanent Monaco/model/listener ownership, whereas a closed
    // disclosure promises it is no longer consuming heavy renderer resources.
    <details
      className="text-[12px] leading-[1.55] text-ink-dim"
      onToggle={event => {
        setOpen(event.currentTarget.open)
      }}
    >
      <summary className="cursor-pointer select-none">
        {summary}
      </summary>
      {open ? <div className="mt-2">{children}</div> : null}
    </details>
  )
}

function toolResultText(content: ToolResultBlock['content']): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return String(content)
  if (content.length === 0) return ''
  const textAt = (index: number): string => {
    const item = content[index]
    return typeof item === 'string' ? item : item?.text ?? ''
  }
  // WHY the one-item fast path matters: provider-normalized results are commonly `[textBlock]`.
  // Joining that array copies a multi-megabyte output before any paging decision can run, doubling
  // peak live memory and blocking input. Multi-part results still require one contiguous durable
  // source for exact paging/copy today, but the pathological common case no longer pays that copy.
  if (content.length === 1) return textAt(0)
  return content.map((_, index) => textAt(index)).join('\n')
}

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
 * Look at the tool_use this result came from (via the feed-level
 * index in context) and decide how to render the result:
 *
 *   Read → strip the "N→" line-number prefix CC's Read tool emits,
 *          and render the contents as a preformatted code slab. We
 *          deliberately skip markdown parsing here because source
 *          code frequently contains triple-backticks and unbalanced
 *          emphasis that would wreck the markdown AST. For full
 *          syntax highlighting later we can feed the stripped text
 *          through highlight.js directly.
 *
 *   Edit / MultiEdit / Write → the diff/content already rendered on
 *          the preceding tool_use row tells the story. The terse
 *          "has been updated successfully" message is pure noise
 *          next to it; suppress for non-errors.
 *
 *   everything else (Bash, Glob, Grep, …) → keep the existing
 *          plain-pre rendering. The content IS the interesting part
 *          for those tools.
 */
export const ToolResultRow = memo(function ToolResultRow({
  block,
}: {
  block: ToolResultBlock
}) {
  const toolUseIndex = useContext(ToolUseIndexContext)
  const codeContext = useContext(CodeRenderContext)
  const sourceTool = toolUseIndex.get(block.tool_use_id)?.name

  const text = toolResultText(block.content)

  const isError = block.is_error === true
  // WHY giant output skips eager trim: trim creates another near-complete
  // string before the paged viewer can discard almost all of it. Small output
  // preserves the historical whitespace cleanup; large output stays as the
  // durable source and each admitted page handles its own presentation.
  const trimmed = text.length <= TEXT_PAGE_MAX_CHARS
    ? text.replace(/\s+$/, '')
    : text

  // File-write tools: the rendered diff/content on the preceding tool_use row
  // already tells the story. The result in all three cases is a stub success
  // string that would just clutter
  // the feed. Errors still fall through to the normal result renderer
  // so failures remain visible.
  if (
    !isError &&
    (sourceTool === 'Edit' ||
      sourceTool === 'MultiEdit' ||
      sourceTool === 'Write')
  ) {
    return null
  }

  // Read tool result — show a one-line summary only, not the file
  // contents. Mirrors claude-code-src/full/tools/FileReadTool/UI.tsx
  // `renderToolResultMessage` which renders "Read <N> lines" at
  // height={1} and never echoes the file bytes into the feed. The
  // user already knows which file was read (it's on the tool-use
  // row); dumping its contents below pushes the next assistant
  // message off-screen for no gain.
  //
  // A click-to-expand <details> keeps the raw content one
  // interaction away for when you actually need it (debugging,
  // code review). Syntax highlighting happens inside CodeBlock
  // only when expanded.
  if (sourceTool === 'Read' && !isError) {
    // WHY count with an index scan instead of split: this summary is rendered
    // before the disclosure opens. Allocating one array element per source line
    // would make the collapsed row pay proportional heap churn for hidden data.
    const lineCount = boundedTextLineCount(trimmed)
    const sourceInput = toolUseIndex.get(block.tool_use_id)?.input as
      | Record<string, unknown>
      | undefined
    const filePath =
      typeof sourceInput?.file_path === 'string'
        ? sourceInput.file_path
        : typeof sourceInput?.path === 'string'
          ? sourceInput.path
          : null
    return (
      <MarkerRow marker="⎿" tone="muted">
        <LazyDetails
          summary={(
            <>
            Read <span className="text-ink font-semibold">
              {lineCount.truncated ? `≥${lineCount.count}` : lineCount.count}
            </span>{' '}
            {lineCount.count === 1 && !lineCount.truncated ? 'line' : 'lines'}
            </>
          )}
        >
          <CodeBlock
            code={trimmed}
            path={filePath}
            workspaceRoot={codeContext.workspaceRoot}
            codeId={`read:${block.tool_use_id}`}
            engine="monaco"
            allowAutoDetect
            transformPage={stripLineNumberPrefix}
          />
        </LazyDetails>
      </MarkerRow>
    )
  }

  // Grep tool result: render with CodeBlock so results get syntax
  // highlighting based on the file pattern / path. Grep output is
  // already formatted text but benefits from language-aware coloring.
  if (sourceTool === 'Grep' && !isError) {
    const sourceInput = toolUseIndex.get(block.tool_use_id)?.input as
      | Record<string, unknown>
      | undefined
    const filePath =
      typeof sourceInput?.path === 'string'
        ? sourceInput.path
        : null
    return (
      <MarkerRow marker="⎿" tone="muted">
        <CodeBlock
          code={trimmed}
          path={filePath}
          workspaceRoot={codeContext.workspaceRoot}
          codeId={`grep:${block.tool_use_id}`}
          engine="monaco"
          allowAutoDetect
        />
      </MarkerRow>
    )
  }

  return (
    <GenericToolResultPresentation
      content={block.content}
      sourceTool={sourceTool}
      text={trimmed}
      isError={isError}
    />
  )
})
