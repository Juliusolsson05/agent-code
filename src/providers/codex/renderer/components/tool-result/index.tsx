// Codex tool-result component (dir-per-component convention, PR #555 —
// see providers/claude/renderer/components/edit/index.tsx for the rule).
//
// One component, several result families: exec_command_end (read/search
// expandables, diff detection), patch_apply_end (error diffs only — success
// is owned by the apply-patch card above), and the generic fallthrough
// (JSON slab, then ANSI-aware OutputWell).

import { memo, useContext, useState } from 'react'

import { CodeBlock } from '@renderer/lib/code/CodeBlock'
import { CodeRenderContext } from '@renderer/features/feed/context'
import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { OutputWell } from '@renderer/lib/text/OutputWell'
import { formatToolFilePath } from '@shared/paths/displayPath'
import type { ToolResultBlock } from '@shared/types/transcript'
import { stripCodexTransportEnvelope } from '@providers/codex/renderer/adapters/command'
import { JsonResultSlab } from '@providers/shared/renderer/rows/JsonResultSlab'
import { tryExtractJson } from '@providers/shared/renderer/rows/jsonToolPresentation'
import { asRecord } from '@shared/lib/asRecord'
import { boundedTextLineCount } from '@renderer/lib/text/boundedText'

// WHY asRecord (the shared helper) and not a local cast: the local copy this
// replaced did NOT exclude arrays — it returned `value as Record<...>` for
// any non-null object including arrays. The shared helper rejects arrays.
// Every call site below uses `.raw` / `.input` style property reads on what
// should always be a plain object, so the stricter check is a free safety
// improvement, not a regression.

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const textAt = (index: number): string => {
      const item = content[index]
      if (typeof item === 'string') return item
      const rec = asRecord(item)
      return typeof rec?.text === 'string' ? rec.text : JSON.stringify(item, null, 2)
    }
    // WHY avoid Array.map().join() for the overwhelmingly common single text block: the result can
    // be megabytes, and joining makes a second full string before bounded rendering gets control.
    // Multi-part output still has to become one exact source for paging/copy, but one block can be
    // handed through by identity with no transient duplicate.
    if (content.length === 1) return textAt(0)
    return content
      .map((_, index) => textAt(index))
      .join('\n')
  }
  return String(content ?? '')
}

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
}: {
  block: ToolResultBlock
}) {
  const codeContext = useContext(CodeRenderContext)
  const materializedText = textFromContent(block.content)
  const text = materializedText.length <= 16 * 1024
    ? materializedText.replace(/\s+$/, '')
    : materializedText
  const meta = asRecord(asRecord(block)?.codex)
  const kind = typeof meta?.kind === 'string' ? meta.kind : null
  const isError = block.is_error === true

  if (kind === 'exec_command_end') {
    const parsed = parsedCommand(meta)
    const parsedType = typeof parsed?.type === 'string' ? parsed.type : null
    const path = parsedPath(parsed)

    if (!text && !isError) return null

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
    if (!isError) return null

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

  if (!text && !isError) return null

  // JSON-shaped fallthrough (wall-time wrapper / MCP envelope / plain
  // JSON) gets the shared collapsed pretty rendering; anything else keeps
  // the truncated text path (residue plan P1 — one result behavior across
  // providers).
  const parsedJson = tryExtractJson(text)
  if (parsedJson !== null && typeof parsedJson === 'object') {
    return <JsonResultSlab value={parsedJson} isError={isError} source={text} />
  }

  // Phase 6 upgrade: OutputWell (ported #524 primitive) replaces the plain
  // truncated row — ANSI-aware painting, HEAD+TAIL preview (head-only
  // clipping hid exactly the final test summary / error lines), loud caps.
  // Codex's unified-exec transport envelope is stripped first (#524 history
  // 661253a8: "Script completed / Wall time / Output:" boilerplate consumed
  // the whole preview — visible in the 2026-07-16 live screenshot too).
  return <OutputWell text={stripCodexTransportEnvelope(text)} isError={isError} />
})
