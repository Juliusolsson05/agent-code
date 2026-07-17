import { canDiffLinesInline, diffLines, type DiffLine } from '@shared/parsers/lineDiff'
import type { ToolUseBlock } from '@shared/types/transcript'
import type {
  CodeEditFile,
  CodeEditRenderModel,
} from '@providers/shared/renderer/protocols/code-edit/model'
import { boundedTextLineCount, boundedTextPage } from '@renderer/lib/text/boundedText'

const MAX_CODE_EDIT_FILES = 24

function boundedSide(
  text: string,
  kind: '-' | '+',
  maxLines: number,
): { lines: DiffLine[]; count: number; previewTruncated: boolean; countTruncated: boolean } {
  const page = boundedTextPage(text, 0, 16 * 1024, maxLines)
  const count = boundedTextLineCount(text)
  const previewLines = text === '' ? [] : page.text.split('\n')
  if (previewLines.length > 0 && previewLines.at(-1) === '' && page.text.endsWith('\n')) {
    previewLines.pop()
  }
  return {
    lines: previewLines.map(line => ({ kind, text: line })),
    count: count.count,
    previewTruncated: page.hasNext,
    countTruncated: count.truncated,
  }
}

// Claude wire → CodeEditRenderModel (renderer rewrite, PR #555; Phase 5
// adapter). Claude-PRIVATE: parses Claude's Edit/MultiEdit/Write input
// vocabulary and nothing else; Codex has its own adapter and they never
// meet above the shared model (the coupling ban that sank PR #524).
//
// STREAMING-FIRST — the design center, per the product owner's explicit
// trap warning: a model must be paintable from the FIRST closed tokens,
// never gated on the full JSON landing. Two entry points express that:
//   - fromClaudeEditBlock: complete-or-partially-decoded blocks (the
//     committed plane, and the live plane's synthetic partial blocks) —
//     missing fields degrade to empty strings, the diff still renders.
//   - fromClaudePartialEditJson: a RAW partial JSON input string straight
//     off the stream — extracts file_path the moment its string closes and
//     diffs the still-open tail of old_string/new_string in place.

function editFile(filePath: string, oldString: string, newString: string, streaming: boolean): CodeEditFile {
  // canDiffLinesInline is the oversize gate the legacy EditRow used — the
  // LCS diff is quadratic, so past its budget we degrade to an
  // everything-removed/everything-added view instead of freezing the paint.
  // Oversize fallback is BOUNDED (review-noted preservation item: the
  // legacy path used a paged viewer; an uncapped -/+ dump of a huge string
  // would mount unbounded DOM). 200 lines per side + an explicit marker —
  // the full content remains in the transcript/committed views.
  const inline = canDiffLinesInline(oldString, newString)
  const removed = inline ? null : boundedSide(oldString, '-', 200)
  const added = inline ? null : boundedSide(newString, '+', 200)
  const lines: DiffLine[] = inline
    ? diffLines(oldString, newString)
    : [...removed!.lines, ...added!.lines]
  const previewTruncated = removed?.previewTruncated === true || added?.previewTruncated === true
  return {
    path: filePath,
    verb: oldString === '' ? 'Creating' : 'Editing',
    lines,
    additions: inline ? lines.filter(l => l.kind === '+').length : added!.count,
    deletions: inline ? lines.filter(l => l.kind === '-').length : removed!.count,
    previewTruncated,
    countsTruncated: removed?.countTruncated === true || added?.countTruncated === true,
    exactSections: previewTruncated
      ? [{ label: 'Before', text: oldString }, { label: 'After', text: newString }]
      : undefined,
    streaming,
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

export function fromClaudeEditBlock(
  block: ToolUseBlock,
  opts: { streaming?: boolean; failed?: boolean; errorSummary?: string } = {},
): CodeEditRenderModel | null {
  const input = (block.input ?? {}) as Record<string, unknown>
  const streaming = opts.streaming === true
  const status = opts.failed ? 'failure' : streaming ? 'streaming' : 'success'
  if (block.name === 'Edit') {
    return {
      label: 'Edit',
      files: [editFile(str(input.file_path), str(input.old_string), str(input.new_string), streaming)],
      status,
      errorSummary: opts.errorSummary,
      partial: streaming,
    }
  }
  if (block.name === 'MultiEdit') {
    const edits = Array.isArray(input.edits) ? (input.edits as Record<string, unknown>[]) : []
    const path = str(input.file_path)
    return {
      label: 'MultiEdit',
      files: edits.slice(0, MAX_CODE_EDIT_FILES).map(e => editFile(path, str(e.old_string), str(e.new_string), streaming)),
      totalFiles: edits.length,
      filesTruncated: edits.length > MAX_CODE_EDIT_FILES,
      status,
      errorSummary: opts.errorSummary,
      partial: streaming,
    }
  }
  if (block.name === 'Write') {
    // Honest Write semantics (plan): no known before-state → pure
    // additions, never a fabricated diff.
    const content = str(input.content)
    const preview = boundedSide(content, '+', 400)
    return {
      label: 'Write',
      files: [
        {
          path: str(input.file_path),
          verb: 'Writing',
          lines: preview.lines,
          additions: preview.count,
          deletions: 0,
          previewTruncated: preview.previewTruncated,
          countsTruncated: preview.countTruncated,
          exactSections: preview.previewTruncated ? [{ label: 'Content', text: content }] : undefined,
          streaming,
        },
      ],
      status,
      errorSummary: opts.errorSummary,
      partial: streaming,
    }
  }
  return null // not an edit-family tool — caller falls through to its route
}

/**
 * Pull one JSON string field out of a PARTIAL JSON text. Scans for
 * `"key":"` then decodes escape-aware up to the closing quote or the end
 * of the buffer. `closed` distinguishes "token finished" (safe to trust,
 * e.g. paint the path) from "still streaming" (paint it growing).
 */
export function extractJsonStringField(
  raw: string,
  key: string,
): { value: string; closed: boolean } | null {
  const keyIdx = raw.indexOf(`"${key}"`)
  if (keyIdx === -1) return null
  const colon = raw.indexOf(':', keyIdx + key.length + 2)
  if (colon === -1) return null
  const open = raw.indexOf('"', colon + 1)
  if (open === -1) return null
  let out = ''
  for (let i = open + 1; i < raw.length; i++) {
    const c = raw[i]
    if (c === '\\') {
      const n = raw[i + 1]
      if (n === undefined) return { value: out, closed: false } // escape torn mid-stream
      if (n === 'n') out += '\n'
      else if (n === 't') out += '\t'
      else if (n === 'r') out += '\r'
      else if (n === 'u') {
        const hex = raw.slice(i + 2, i + 6)
        if (hex.length < 4) return { value: out, closed: false }
        out += String.fromCharCode(parseInt(hex, 16))
        i += 4
      } else out += n
      i += 1
      continue
    }
    if (c === '"') return { value: out, closed: true }
    out += c
  }
  return { value: out, closed: false }
}

/** RAW streaming input JSON → model, ASAP. Returns null until the tool is
 *  recognizable as edit-family AND file_path has CLOSED (the earliest
 *  honest paint point — a half-streamed path must not render). */
export function fromClaudePartialEditJson(
  toolName: string,
  rawInputJson: string,
): CodeEditRenderModel | null {
  if (toolName !== 'Edit' && toolName !== 'Write') return null
  const path = extractJsonStringField(rawInputJson, 'file_path')
  if (!path || !path.closed) return null
  if (toolName === 'Write') {
    const content = extractJsonStringField(rawInputJson, 'content')
    const preview = boundedSide(content?.value ?? '', '+', 400)
    return {
      label: 'Write',
      files: [{
        path: path.value,
        verb: 'Writing',
        lines: preview.lines,
        additions: preview.count,
        deletions: 0,
        previewTruncated: preview.previewTruncated,
        countsTruncated: preview.countTruncated,
        streaming: true,
      }],
      status: 'streaming',
      partial: true,
    }
  }
  const oldS = extractJsonStringField(rawInputJson, 'old_string')
  const newS = extractJsonStringField(rawInputJson, 'new_string')
  return {
    label: 'Edit',
    files: [editFile(path.value, oldS?.value ?? '', newS?.value ?? '', true)],
    status: 'streaming',
    partial: true,
  }
}
