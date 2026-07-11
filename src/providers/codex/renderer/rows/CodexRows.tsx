import { memo, useContext, useState } from 'react'

import { CodeBlock } from '@renderer/lib/code/CodeBlock'
import { CodeRenderContext } from '@renderer/features/feed/context'
import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { formatToolFilePath } from '@shared/paths/displayPath'
import type { ToolResultBlock } from '@shared/types/transcript'

import { JsonResultSlab } from '@providers/shared/renderer/rows/JsonResultSlab'
import { tryExtractJson } from '@providers/shared/renderer/rows/jsonToolPresentation'
import { asRecord } from '@shared/lib/asRecord'
import { OutputWell } from '@renderer/features/feed/ui/kit/OutputWell'
// WHY the import switch matters here: the local copy this replaced
// did NOT exclude arrays — it returned `value as Record<...>` for
// any non-null object including arrays. The shared helper rejects
// arrays. Every call site below was using `.raw` / `.input` style
// property reads on what should always be a plain object, so the
// stricter check is a free safety improvement, not a regression.
// If a future caller wants array-as-record they should use a
// different helper or do the cast inline.

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(item => {
        if (typeof item === 'string') return item
        const rec = asRecord(item)
        return typeof rec?.text === 'string' ? rec.text : JSON.stringify(item, null, 2)
      })
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

function countNonEmptyLines(text: string): number {
  if (!text.trim()) return 0
  return text.split('\n').length
}

function summaryLabelForCommandResult(
  parsedType: string | null,
  lineCount: number,
  path: string | null,
  workspaceRoot: string | null,
): string {
  const displayPath = path ? formatToolFilePath(path, workspaceRoot) : null
  if (parsedType === 'read') {
    const noun = lineCount === 1 ? 'line' : 'lines'
    return displayPath
      ? `Read ${lineCount} ${noun} from ${displayPath}`
      : `Read ${lineCount} ${noun}`
  }
  if (parsedType === 'search') {
    const noun = lineCount === 1 ? 'line' : 'lines'
    return displayPath
      ? `Search results: ${lineCount} ${noun} in ${displayPath}`
      : `Search results: ${lineCount} ${noun}`
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
  const [opened, setOpened] = useState(false)
  return (
    <MarkerRow marker="⎿" tone="muted">
      {/* Closed <details> still mounts React children. Keep the Monaco
          CodeBlock behind first-open state so a resumed transcript with
          many read/search results does not create hidden editors, models,
          LSP documents, and diagnostics listeners before the user asks to
          inspect the raw payload. Once opened, keep it mounted so copy-code
          IDs and Monaco state remain stable while the user expands/collapses. */}
      <details
        className="text-[12px] leading-[1.55] text-ink-dim"
        onToggle={event => {
          if (event.currentTarget.open) setOpened(true)
        }}
      >
        <summary className="cursor-pointer select-none">
          {summary}
        </summary>
        {opened ? (
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
  const text = textFromContent(block.content).replace(/\s+$/, '')
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
      const lineCount = countNonEmptyLines(text)
      const summary = summaryLabelForCommandResult(
        parsedType,
        lineCount,
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

  // NOTE: the patch_apply_end branch that used to live here is GONE on
  // purpose — file-edit results are suppressed upstream in Block.tsx
  // (RESULT_CONSUMING_FAMILIES) and rendered inside DiffCard, including
  // the per-file tinted unified_diffs on failure.

  if (!text && !isError) return null

  // JSON-shaped fallthrough (wall-time wrapper / MCP envelope / plain
  // JSON) gets the shared collapsed pretty rendering; anything else keeps
  // the truncated text path (residue plan P1 — one result behavior across
  // providers).
  const parsedJson = tryExtractJson(text)
  if (parsedJson !== null && typeof parsedJson === 'object') {
    return <JsonResultSlab value={parsedJson} isError={isError} />
  }

  return <OutputWell text={text} isError={isError} ansi />
})
