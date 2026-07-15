import { memo, useContext, useMemo, useState } from 'react'

import type { DiffLine } from '@shared/parsers/lineDiff'
import { CodeBlock } from '@renderer/lib/code/CodeBlock'
import { CodeRenderContext } from '@renderer/features/feed/context'
import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { TruncatedOutputRow } from '@renderer/features/feed/ui/rows/TruncatedOutputRow'
import { formatToolFilePath } from '@shared/paths/displayPath'
import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'

import { JsonResultSlab } from '@providers/shared/renderer/rows/JsonResultSlab'
import { tryExtractJson } from '@providers/shared/renderer/rows/jsonToolPresentation'
import { asRecord } from '@shared/lib/asRecord'
import { DiffSlab } from '@providers/shared/renderer/rows/DiffSlab'
import {
  boundedTextPage,
  countTextLines,
} from '@renderer/lib/text/boundedText'
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

function summarizePatchTargets(input: unknown): string[] {
  const fullText =
    typeof input === 'string'
      ? input
      : typeof asRecord(input)?.raw === 'string'
        ? String(asRecord(input)?.raw)
        : ''
  if (!fullText) return []

  // WHY only scan one renderer page: this headline is a preview, not a patch
  // parser. Spreading matchAll over a generated megabyte patch allocates every
  // match before slice(0, 6) can discard them, and repeats during live deltas.
  const text = boundedTextPage(fullText).text
  const targets: string[] = []
  for (const match of text.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
    targets.push(match[1])
    if (targets.length >= 6) break
  }
  return targets
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
  if (typeof rec?.cmd === 'string') return rec.cmd
  if (typeof rec?.patch === 'string') return rec.patch
  if (typeof rec?.input === 'string') return rec.input
  return ''
}

function parseApplyPatch(input: unknown): ApplyPatchFile[] {
  const fullText = applyPatchText(input)
  if (!fullText.includes('*** Begin Patch')) return []

  // WHY the rich diff card parses only one bounded page: DiffSlab creates a
  // node per line. CSS clipping never reduced that parse/DOM/layout cost. The
  // durable tool input still owns the complete patch; this card is explicitly
  // a safe preview of its leading files/hunks.
  const text = boundedTextPage(fullText).text

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

function headlineForTool(block: ToolUseBlock): string | null {
  const input = asRecord(block.input)
  if (!input) return null

  if (block.name === 'write_stdin') {
    const chars = input.chars
    if (typeof chars === 'string' && chars.length > 0) return chars
    return null
  }

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
  // Path BEFORE description (corpus bug, plan-json-tool-rows §1b):
  // ai_workspace_attach_file showed its description gloss while hiding
  // the actual file path. A path is an identifier; a description is
  // commentary.
  if (typeof input.path === 'string') return input.path
  if (typeof input.description === 'string') return input.description
  if (typeof input.arguments === 'string') return input.arguments.slice(0, 160)
  if (typeof input.raw === 'string' && block.name !== 'apply_patch') return input.raw.slice(0, 160)
  return null
}

const MAX_COMMAND_DISPLAY_LINES = 2
const MAX_COMMAND_DISPLAY_CHARS = 160
type ExecCommandInput = {
  command: string
  workdir: string | null
  yieldTimeMs: number | null
  maxOutputTokens: number | null
}

function execCommandInput(input: unknown): ExecCommandInput | null {
  const rec = asRecord(input)
  if (!rec) return null
  const rawCommand = rec.cmd ?? rec.command
  const command = Array.isArray(rawCommand)
    ? rawCommand.map(String).join(' ')
    : typeof rawCommand === 'string'
      ? rawCommand
      : ''
  if (!command.trim()) return null
  return {
    command,
    workdir: typeof rec.workdir === 'string' ? rec.workdir : null,
    yieldTimeMs: typeof rec.yield_time_ms === 'number' ? rec.yield_time_ms : null,
    maxOutputTokens:
      typeof rec.max_output_tokens === 'number' ? rec.max_output_tokens : null,
  }
}

function truncateCommand(text: string): string {
  const page = boundedTextPage(
    text,
    0,
    MAX_COMMAND_DISPLAY_CHARS,
    MAX_COMMAND_DISPLAY_LINES,
  )
  if (!page.hasNext) return text
  return page.text.trimEnd() + '…'
}

export const CodexExecCommandRow = memo(function CodexExecCommandRow({
  block,
}: {
  block: ToolUseBlock
}) {
  const { workspaceRoot } = useContext(CodeRenderContext)
  const parsed = useMemo(() => execCommandInput(block.input), [block.input])
  if (!parsed) return <CodexToolRow block={block} />

  const displayWorkdir = parsed.workdir
    ? formatToolFilePath(parsed.workdir, workspaceRoot)
    : null
  const meta = [
    displayWorkdir ? `cwd ${displayWorkdir}` : null,
    parsed.yieldTimeMs !== null ? `yield ${parsed.yieldTimeMs}ms` : null,
    parsed.maxOutputTokens !== null ? `max ${parsed.maxOutputTokens} tokens` : null,
  ].filter((item): item is string => item !== null)

  return (
    <MarkerRow marker="⏺">
      <div className="min-w-0">
        <div className="text-[13px] leading-[1.65] flex items-baseline gap-2 min-w-0">
          <span className="text-accent font-semibold flex-shrink-0">Run</span>
          {meta.length > 0 && (
            <span className="text-muted text-[11px] truncate min-w-0">
              {meta.join(' · ')}
            </span>
          )}
        </div>
        {/* WHY this is a command-specific row instead of the generic
            `exec_command` tool card:

            Codex's semantic name is an implementation detail. The
            user-facing object is the shell command, and the 2026-05-16
            HTML bundle showed the old card wasting the first line on
            `exec_command` while burying the actual command in a nested
            child row. That made dense debug sessions scan like a list
            of identical provider internals. Keeping the marker row but
            promoting the command to the primary surface makes live and
            committed command calls readable without changing ownership
            or result pairing. */}
        <pre className="mt-0.5 font-code text-[12px] leading-[1.55] text-ink-dim whitespace-pre-wrap break-words m-0">
          <span className="select-none text-muted">$ </span>
          {truncateCommand(parsed.command)}
        </pre>
      </div>
    </MarkerRow>
  )
})

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
  return countTextLines(text)
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

export const CodexWriteStdinRow = memo(function CodexWriteStdinRow({
  block,
}: {
  block: ToolUseBlock
}) {
  const input = asRecord(block.input)
  const chars = typeof input?.chars === 'string' ? input.chars : ''

  // WHY empty write_stdin renders nothing:
  // Codex uses write_stdin for two very different things: real input
  // into an ongoing command, and empty/poll continuation calls while
  // a long-running PTY command is still draining output. The latter
  // created the ugly one-line `write_stdin` rows visible in the
  // 2026-05-16T18:54 bundle: no path, no command, no payload, just a
  // provider implementation detail. Empty stdin has no user-visible
  // content, so the command/result row remains the owner of the UI.
  if (!chars) return null

  return (
    <MarkerRow marker="⏺">
      <div>
        <div className="text-[13px] leading-[1.65]">
          <span className="text-accent font-semibold">stdin</span>
        </div>
        <MarkerRow marker="⎿" tone="muted">
          <pre className="font-code text-[12px] leading-[1.55] text-ink-dim whitespace-pre-wrap break-all m-0">
            {truncateCommand(chars)}
          </pre>
        </MarkerRow>
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
            <DiffSlab lines={file.lines} filePath={file.path} emptyLabel="(no inline diff)" />
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

  // JSON-shaped fallthrough (wall-time wrapper / MCP envelope / plain
  // JSON) gets the shared collapsed pretty rendering; anything else keeps
  // the truncated text path (residue plan P1 — one result behavior across
  // providers).
  const parsedJson = tryExtractJson(text)
  if (parsedJson !== null && typeof parsedJson === 'object') {
    return <JsonResultSlab value={parsedJson} isError={isError} />
  }

  return <TruncatedOutputRow content={text} isError={isError} />
})
