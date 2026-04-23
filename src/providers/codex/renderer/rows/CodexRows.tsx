import { memo, useContext, useMemo, useState } from 'react'

import { CodeBlock } from '../../../../renderer/src/lib/code/CodeBlock'
import { CodeRenderContext, MarkerRow } from '../../../../renderer/src/feed/Feed'
import { formatToolFilePath } from '../../../../shared/paths/displayPath'
import type { ToolResultBlock, ToolUseBlock } from '../../../../shared/types/transcript'

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

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

function summarizePatchTargets(input: unknown): string[] {
  const text =
    typeof input === 'string'
      ? input
      : typeof asRecord(input)?.raw === 'string'
        ? String(asRecord(input)?.raw)
        : ''
  if (!text) return []
  const matches = [...text.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)]
  return matches.map(match => match[1]).slice(0, 6)
}

function headlineForTool(block: ToolUseBlock): string | null {
  const input = asRecord(block.input)
  if (!input) return null

  if (block.name === 'exec_command') {
    const cmd = input.cmd
    if (typeof cmd === 'string') return cmd
    if (Array.isArray(cmd)) return cmd.join(' ')
  }

  if (block.name === 'apply_patch') {
    const targets = summarizePatchTargets(block.input)
    if (targets.length > 0) return targets.join('\n')
  }

  if (typeof input.command === 'string') return input.command
  if (typeof input.description === 'string') return input.description
  if (typeof input.path === 'string') return input.path
  if (typeof input.arguments === 'string') return input.arguments.slice(0, 160)
  if (typeof input.raw === 'string' && block.name !== 'apply_patch') return input.raw.slice(0, 160)
  return null
}

const MAX_COMMAND_DISPLAY_LINES = 2
const MAX_COMMAND_DISPLAY_CHARS = 160
const RESULT_MAX_LINES = 3

function truncateCommand(text: string): string {
  const lines = text.split('\n')
  const needsLineTruncation = lines.length > MAX_COMMAND_DISPLAY_LINES
  const needsCharTruncation = text.length > MAX_COMMAND_DISPLAY_CHARS
  if (!needsLineTruncation && !needsCharTruncation) return text

  let truncated = text
  if (needsLineTruncation) {
    truncated = lines.slice(0, MAX_COMMAND_DISPLAY_LINES).join('\n')
  }
  if (truncated.length > MAX_COMMAND_DISPLAY_CHARS) {
    truncated = truncated.slice(0, MAX_COMMAND_DISPLAY_CHARS)
  }
  return truncated.trimEnd() + '…'
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
  return (
    <MarkerRow marker="⎿" tone="muted">
      <details className="text-[12px] leading-[1.55] text-ink-dim">
        <summary className="cursor-pointer select-none">
          {summary}
        </summary>
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
      </details>
    </MarkerRow>
  )
}

function TruncatedOutputRow({
  content,
  isError,
}: {
  content: string
  isError: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const lines = content.length === 0 ? [] : content.split('\n')
  const needsTruncation = lines.length > RESULT_MAX_LINES
  const shown = expanded || !needsTruncation
    ? content
    : lines.slice(0, RESULT_MAX_LINES).join('\n')
  const hiddenCount = needsTruncation ? lines.length - RESULT_MAX_LINES : 0

  return (
    <MarkerRow marker="⎿" tone="muted">
      <div className="min-w-0">
        <pre
          className={`
            font-code text-[12px] leading-[1.55] whitespace-pre-wrap break-words m-0
            ${expanded ? 'max-h-[360px] overflow-auto' : ''}
            ${isError ? 'text-danger' : 'text-ink-dim'}
          `}
        >
          {shown || '(no output)'}
        </pre>
        {needsTruncation && (
          <button
            type="button"
            onClick={() => setExpanded(prev => !prev)}
            className="mt-1 text-[11px] text-muted hover:text-ink cursor-pointer"
          >
            {expanded
              ? 'collapse'
              : `… +${hiddenCount} ${hiddenCount === 1 ? 'line' : 'lines'} (click to expand)`}
          </button>
        )}
      </div>
    </MarkerRow>
  )
}

export const CodexToolRow = memo(function CodexToolRow({
  block,
}: {
  block: ToolUseBlock
}) {
  const headline = useMemo(() => {
    const raw = headlineForTool(block)
    if (!raw) return null
    if (block.name === 'exec_command') return truncateCommand(raw)
    return raw
  }, [block])

  return (
    <MarkerRow marker="⏺">
      <div>
        <div className="text-[13px] leading-[1.65]">
          <span className="text-accent font-semibold">{block.name}</span>
        </div>
        {headline && (
          <MarkerRow marker="⎿" tone="muted">
            <pre className="font-code text-[12px] leading-[1.55] text-ink-dim whitespace-pre-wrap break-all m-0">
              {headline}
            </pre>
          </MarkerRow>
        )}
      </div>
    </MarkerRow>
  )
})

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

  if (!text && !isError) return null

  return <TruncatedOutputRow content={text} isError={isError} />
})
