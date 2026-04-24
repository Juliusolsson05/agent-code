import { memo, useContext, useMemo, useState } from 'react'
import hljs from 'highlight.js'

import { normalizeCodeLanguage } from '@shared/code/language'
import type { DiffLine } from '@shared/parsers/lineDiff'
import { CodeBlock } from '@renderer/lib/code/CodeBlock'
import { CodeRenderContext } from '@renderer/features/feed/ui/Feed'
import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { formatToolFilePath } from '@shared/paths/displayPath'
import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'

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

type ApplyPatchFile = {
  path: string
  action: 'Add' | 'Update' | 'Delete'
  movedTo?: string
  lines: DiffLine[]
}

function applyPatchText(input: unknown): string {
  if (typeof input === 'string') return input
  const rec = asRecord(input)
  if (typeof rec?.raw === 'string') return rec.raw
  if (typeof rec?.arguments === 'string') return rec.arguments
  return ''
}

function parseApplyPatch(input: unknown): ApplyPatchFile[] {
  const text = applyPatchText(input)
  if (!text.includes('*** Begin Patch')) return []

  const files: ApplyPatchFile[] = []
  let current: ApplyPatchFile | null = null

  for (const rawLine of text.split('\n')) {
    const fileMatch = rawLine.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/)
    if (fileMatch) {
      current = {
        action: fileMatch[1] as ApplyPatchFile['action'],
        path: fileMatch[2] ?? '',
        lines: [],
      }
      files.push(current)
      continue
    }

    if (!current) continue

    const moveMatch = rawLine.match(/^\*\*\* Move to: (.+)$/)
    if (moveMatch) {
      current.movedTo = moveMatch[1] ?? ''
      continue
    }

    if (
      rawLine === '*** Begin Patch' ||
      rawLine === '*** End Patch' ||
      rawLine === '*** End of File' ||
      rawLine.startsWith('@@')
    ) {
      continue
    }

    if (rawLine.startsWith('+')) {
      current.lines.push({ kind: '+', text: rawLine.slice(1) })
    } else if (rawLine.startsWith('-')) {
      current.lines.push({ kind: '-', text: rawLine.slice(1) })
    } else if (rawLine.startsWith(' ')) {
      current.lines.push({ kind: 'ctx', text: rawLine.slice(1) })
    }
  }

  return files
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function toHighlightLanguage(language: string): string | null {
  if (language === 'javascriptreact') return 'javascript'
  if (language === 'typescriptreact') return 'typescript'
  return hljs.getLanguage(language) ? language : null
}

function PatchFileHeader({
  action,
  path,
  movedTo,
}: {
  action: ApplyPatchFile['action']
  path: string
  movedTo?: string
}) {
  const { workspaceRoot } = useContext(CodeRenderContext)
  const display = formatToolFilePath(path, workspaceRoot)
  const movedDisplay = movedTo ? formatToolFilePath(movedTo, workspaceRoot) : null
  const extra = movedDisplay
    ? `${action.toLowerCase()} -> ${movedDisplay}`
    : action.toLowerCase()
  return (
    <div className="text-[13px] leading-[1.65] flex items-baseline min-w-0" title={path || undefined}>
      <span className="text-accent font-semibold flex-shrink-0">ApplyPatch</span>
      {display && (
        <span
          className="text-ink-dim ml-2 font-code text-[12px] truncate min-w-0"
          style={{ direction: 'rtl', textAlign: 'left' }}
        >
          {display}
        </span>
      )}
      <span className="text-muted ml-2 text-[11px] flex-shrink-0">{extra}</span>
    </div>
  )
}

function PatchDiffSlab({
  lines,
  filePath,
}: {
  lines: DiffLine[]
  filePath?: string
}) {
  if (lines.length === 0) {
    return (
      <div className="bg-code-bg text-muted text-[11px] font-code px-3 py-2">
        (no inline diff)
      </div>
    )
  }
  const highlightLanguage = useMemo(() => {
    return toHighlightLanguage(normalizeCodeLanguage(undefined, filePath))
  }, [filePath])
  const renderedLines = useMemo(
    () =>
      lines.map(line => {
        if (line.text === '') return '\u200b'
        if (!highlightLanguage) return escapeHtml(line.text)
        return hljs.highlight(line.text, { language: highlightLanguage }).value
      }),
    [highlightLanguage, lines],
  )
  return (
    <div className="bg-code-bg font-code text-[12px] leading-[1.55] overflow-x-auto">
      <div className="w-max min-w-full">
        {lines.map((line, index) => {
          const bg =
            line.kind === '+'
              ? 'bg-diff-add-bg'
              : line.kind === '-'
                ? 'bg-diff-remove-bg'
                : ''
          const fg =
            line.kind === '+'
              ? 'text-diff-add-fg'
              : line.kind === '-'
                ? 'text-diff-remove-fg'
                : 'text-code-ink-dim'
          const bodyTone = line.kind === 'ctx' ? 'text-code-ink-dim' : 'text-code-ink'
          return (
            <div
              key={index}
              className={`${bg} flex items-start px-3 whitespace-pre`}
            >
              <span
                className={`${fg} select-none w-4 flex-shrink-0 tabular-nums`}
                aria-hidden="true"
              >
                {line.kind === 'ctx' ? ' ' : line.kind}
              </span>
              <span
                className={`${bodyTone} diff-line-code hljs flex-1 min-w-0 break-all`}
                dangerouslySetInnerHTML={{ __html: renderedLines[index] ?? '\u200b' }}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
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

export const CodexApplyPatchRow = memo(function CodexApplyPatchRow({
  block,
}: {
  block: ToolUseBlock
}) {
  const files = useMemo(() => parseApplyPatch(block.input), [block.input])

  if (files.length === 0) {
    return <CodexToolRow block={block} />
  }

  return (
    <MarkerRow marker="⏺">
      <div className="flex flex-col gap-2">
        {files.map((file, index) => (
          <div key={`${file.path}:${index}`} className="flex flex-col gap-1">
            <PatchFileHeader
              action={file.action}
              path={file.path}
              movedTo={file.movedTo}
            />
            <PatchDiffSlab lines={file.lines} filePath={file.path} />
          </div>
        ))}
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

  return <TruncatedOutputRow content={text} isError={isError} />
})
