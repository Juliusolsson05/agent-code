// Codex tool-result component (dir-per-component convention, PR #555 —
// see providers/claude/renderer/components/edit/index.tsx for the rule).
//
// One component, several result families: exec_command_end (read/search
// expandables, diff detection), patch_apply_end (error diffs only — success
// is owned by the apply-patch card above), and the generic fallthrough
// (JSON slab, then ANSI-aware OutputWell).

import { memo, useContext, useMemo, useState } from 'react'

import { CodeBlock } from '@renderer/lib/code/CodeBlock'
import { CodeRenderContext } from '@renderer/features/feed/context'
import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { OutputWell } from '@renderer/lib/text/OutputWell'
import { formatToolFilePath } from '@shared/paths/displayPath'
import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'
import { stripCodexTransportEnvelope } from '@providers/codex/renderer/adapters/command'
import { JsonResultSlab } from '@providers/shared/renderer/rows/JsonResultSlab'
import { tryExtractJson } from '@providers/shared/renderer/rows/jsonToolPresentation'
import { StructuredOutputView } from '@providers/shared/renderer/protocols/structured-output/StructuredOutputView'
import { parseStructuredOutput } from '@providers/shared/renderer/protocols/structured-output/model'
import { McpContentView } from '@providers/shared/renderer/protocols/mcp-content/McpContentView'
import {
  isMcpContentCarrier,
  parseMcpContentResult,
} from '@providers/shared/renderer/protocols/mcp-content/model'
import { asRecord } from '@shared/lib/asRecord'
import { boundedTextLineCount } from '@renderer/lib/text/boundedText'
import { toolResultContentText } from '@providers/shared/renderer/rows/toolResultContent'
import { ResultParts, hasRenderableMedia } from '@providers/shared/renderer/rows/ResultParts'

// WHY asRecord (the shared helper) and not a local cast: the local copy this
// replaced did NOT exclude arrays — it returned `value as Record<...>` for
// any non-null object including arrays. The shared helper rejects arrays.
// Every call site below uses `.raw` / `.input` style property reads on what
// should always be a plain object, so the stricter check is a free safety
// improvement, not a regression.

function detectDiff(text: string): boolean {
  return text.startsWith('diff --git ') || text.startsWith('@@ ')
}

function parsedCommand(meta: Record<string, unknown> | null): Record<string, unknown> | null {
  const parsed = meta?.parsedCmd
  if (!Array.isArray(parsed)) return null
  return asRecord(parsed[0])
}

function parsedPath(parsed: Record<string, unknown> | null): string | null {
  if (typeof parsed?.path === 'string') return parsed.path
  if (typeof parsed?.name === 'string') return parsed.name
  return null
}

function summaryLabelForCommandResult(
  parsedType: string | null,
  lineCount: number,
  lineCountTruncated: boolean,
  path: string | null,
  workspaceRoot: string | null,
): string {
  const displayPath = path ? formatToolFilePath(path, workspaceRoot) : null
  const countLabel = lineCountTruncated ? `≥${lineCount}` : String(lineCount)
  if (parsedType === 'read') {
    const noun = lineCount === 1 && !lineCountTruncated ? 'line' : 'lines'
    return displayPath
      ? `Read ${countLabel} ${noun} from ${displayPath}`
      : `Read ${countLabel} ${noun}`
  }
  if (parsedType === 'search') {
    const noun = lineCount === 1 && !lineCountTruncated ? 'line' : 'lines'
    return displayPath
      ? `Search results: ${countLabel} ${noun} in ${displayPath}`
      : `Search results: ${countLabel} ${noun}`
  }
  return displayPath ?? 'Result'
}

function ExpandableCodeResult({
  summary,
  code,
  path,
  workspaceRoot,
  codeId,
  language,
}: {
  summary: string
  code: string
  path?: string | null
  workspaceRoot?: string | null
  codeId: string
  language?: string | null
}) {
  const [open, setOpen] = useState(false)
  return (
    <MarkerRow marker="⎿" tone="muted">
      {/* WHY close destroys the child instead of latching first-open: restored
          sessions can contain hundreds of previously inspected reads. A latch
          turns every historical click into permanent editor/model ownership.
          Recreating one bounded page on the next explicit open is cheaper and
          preserves the invariant that collapsed content owns no heavy UI. */}
      <details
        className="text-[12px] leading-[1.55] text-ink-dim"
        onToggle={event => {
          setOpen(event.currentTarget.open)
        }}
      >
        <summary className="cursor-pointer select-none">
          {summary}
        </summary>
        {open ? (
          <div className="mt-2">
          <CodeBlock
            code={code}
            path={path}
            language={language}
            workspaceRoot={workspaceRoot}
            codeId={codeId}
            engine="monaco"
            allowAutoDetect={!language}
          />
          </div>
        ) : null}
      </details>
    </MarkerRow>
  )
}

export const CodexToolResultRow = memo(function CodexToolResultRow({
  block,
  sourceTool,
}: {
  block: ToolResultBlock
  sourceTool?: ToolUseBlock | null
}) {
  const codeContext = useContext(CodeRenderContext)

  // THE reported bug's painter. `renderCodexToolResult` (../rows/dispatch.tsx)
  // claims every result whose correlated call is named `exec` and whose
  // envelope is `custom_tool_call_output` — which is exactly how Codex returns
  // an image-bearing shell result. Without this branch the mapping boundary
  // correctly produces text,image,text,image blocks and then this component
  // flattens them straight back to labels, so the base64 dump is gone but no
  // image ever paints. The first version of this change shipped precisely that
  // half-fix; review caught it.
  //
  // WHY the decision is computed here but ACTED ON below the hooks: this
  // component calls useMemo further down, so returning here would change the
  // hook count between renders and crash React's dispatcher. The first draft of
  // this fix did exactly that.
  const mediaParts = hasRenderableMedia(block.content) ? block.content : null

  const materializedText = toolResultContentText(block.content)
  const text = materializedText.length <= 16 * 1024
    ? materializedText.replace(/\s+$/, '')
    : materializedText
  const meta = asRecord(asRecord(block)?.codex)
  const kind = typeof meta?.kind === 'string' ? meta.kind : null
  const isError = block.is_error === true

  // Current unified `exec` calls often contain an MCP call rather than a
  // shell command. Their result is still wrapped in Codex's human transport
  // header (`Script completed / Wall time / Output`) before the serialized
  // CallToolResult. Strip only that verified provider envelope, then give the
  // payload to the shared structured recognizers.
  const payloadText = sourceTool?.name === 'exec' || sourceTool?.name === 'wait'
    ? stripCodexTransportEnvelope(text)
    : text
  const outputPresentation = useMemo(() => {
    const json = tryExtractJson(payloadText)
    const mcp = parseMcpContentResult(payloadText)
    const ownsMcp = mcp !== null && isMcpContentCarrier(json)
    return {
      json: !ownsMcp && json !== null && typeof json === 'object' ? json : null,
      mcp: ownsMcp ? mcp : null,
      structured: ownsMcp || (json !== null && typeof json === 'object')
        ? null
        : parseStructuredOutput(payloadText),
    }
  }, [payloadText])

  // THE reported bug's painter. `renderCodexToolResult` (../rows/dispatch.tsx)
  // claims every result whose correlated call is named `exec` and whose envelope
  // is `custom_tool_call_output` — exactly how Codex returns an image-bearing
  // shell result — so this component, not the generic ToolResultRow, is what
  // paints the screenshot in the bug report. Without this branch the mapping
  // boundary correctly produces text,image,text,image blocks and then
  // `toolResultContentText` above flattens them straight back to labels: the
  // megabyte dump is gone but no image ever appears. The first version of this
  // change shipped precisely that half-fix; review caught it.
  //
  // First of the result-family branches because a structured block array can
  // carry neither Codex's transport envelope nor a serialized JSON payload, so
  // every branch below it is inapplicable by construction.
  if (mediaParts) {
    return (
      <ResultParts
        parts={mediaParts}
        renderText={(partText, key) => (
          <OutputWell key={key} text={partText} isError={isError} />
        )}
      />
    )
  }

  if (kind === 'exec_command_end') {
    const parsed = parsedCommand(meta)
    const parsedType = typeof parsed?.type === 'string' ? parsed.type : null
    const path = parsedPath(parsed)

    if (
      (parsedType === 'read' || parsedType === 'search') &&
      path &&
      text
    ) {
      const lineCount = boundedTextLineCount(text)
      const summary = summaryLabelForCommandResult(
        parsedType,
        lineCount.count,
        lineCount.truncated,
        path,
        codeContext.workspaceRoot,
      )
      return (
        <ExpandableCodeResult
          summary={summary}
          code={text}
          path={path}
          workspaceRoot={codeContext.workspaceRoot}
          codeId={`codex-${parsedType}:${block.tool_use_id}`}
        />
      )
    }

    if (detectDiff(text)) {
      return (
        <MarkerRow marker="⎿" tone="muted">
          <CodeBlock
            code={text}
            language="diff"
            workspaceRoot={codeContext.workspaceRoot}
            codeId={`codex-diff:${block.tool_use_id}`}
          />
        </MarkerRow>
      )
    }
  }

  if (kind === 'patch_apply_end') {
    const changes = asRecord(meta?.changes)
    const items = changes ? Object.entries(changes) : []
    if (items.length > 0) {
      return (
        <MarkerRow marker="⎿" tone="muted">
          <div className="flex flex-col gap-2 w-full">
            {items.map(([filePath, change]) => {
              const rec = asRecord(change)
              const diff = typeof rec?.unified_diff === 'string' ? rec.unified_diff : ''
              return (
                <div key={filePath} className="flex flex-col gap-1">
                  <div
                    className="text-[12px] text-ink-dim font-code break-all"
                    // Raw absolute path stays in the tooltip so hover
                    // always reveals the unambiguous location, even
                    // when the body shows the workspace-relative form.
                    title={filePath}
                  >
                    {formatToolFilePath(filePath, codeContext.workspaceRoot)}
                  </div>
                  {diff ? (
                    <CodeBlock
                      code={diff}
                      language="diff"
                      workspaceRoot={codeContext.workspaceRoot}
                      codeId={`codex-patch:${block.tool_use_id}:${filePath}`}
                    />
                  ) : text ? (
                    <CodeBlock
                      code={text}
                      workspaceRoot={codeContext.workspaceRoot}
                      codeId={`codex-patch-fallback:${block.tool_use_id}:${filePath}`}
                      engine="monaco"
                      allowAutoDetect
                    />
                  ) : null}
                </div>
              )
            })}
          </div>
        </MarkerRow>
      )
    }
  }

  // JSON-shaped fallthrough (wall-time wrapper / MCP envelope / plain
  // JSON) gets the shared collapsed pretty rendering; anything else keeps
  // the truncated text path (residue plan P1 — one result behavior across
  // providers).
  // Current unified `exec` results are already stripped above before being
  // given to the same bounded JSON/MCP parser as direct results. This does
  // NOT merge the exec with an orchestration operation—cell correlation is
  // not proven—but it makes the nested structured evidence readable instead
  // of displaying two levels of escaped JSON.
  // Only unified `exec` owns this human transport envelope. Direct command,
  // MCP, and future result families may legitimately begin with the same
  // English words and must not have their evidence peeled heuristically.
  if (outputPresentation.json !== null) {
    return <JsonResultSlab value={outputPresentation.json} isError={isError} source={text} />
  }
  if (outputPresentation.mcp !== null) {
    return <McpContentView model={outputPresentation.mcp} source={text} transportError={isError} />
  }
  if (outputPresentation.structured !== null) {
    return (
      <StructuredOutputView
        model={outputPresentation.structured}
        source={text}
        isError={isError}
      />
    )
  }

  // Phase 6 upgrade: OutputWell (ported #524 primitive) replaces the plain
  // truncated row — ANSI-aware painting, HEAD+TAIL preview (head-only
  // clipping hid exactly the final test summary / error lines), loud caps.
  // Codex's unified-exec transport envelope is stripped first (#524 history
  // 661253a8: "Script completed / Wall time / Output:" boilerplate consumed
  // the whole preview — visible in the 2026-07-16 live screenshot too).
  return <OutputWell text={payloadText} isError={isError} />
})
