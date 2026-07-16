import { canDiffLinesInline, diffLines, type DiffLine } from '@shared/parsers/lineDiff'
import type { ToolUseBlock } from '@shared/types/transcript'
import type {
  CodeEditFile,
  CodeEditRenderModel,
} from '@providers/shared/renderer/protocols/code-edit/model'

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
  const lines: DiffLine[] = canDiffLinesInline(oldString, newString)
    ? diffLines(oldString, newString)
    : [
        ...oldString.split('\n').map(text => ({ kind: '-' as const, text })),
        ...newString.split('\n').map(text => ({ kind: '+' as const, text })),
      ]
  return {
    path: filePath,
    verb: oldString === '' ? 'Creating' : 'Editing',
    lines,
    additions: lines.filter(l => l.kind === '+').length,
    deletions: lines.filter(l => l.kind === '-').length,
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
      files: edits.map(e => editFile(path, str(e.old_string), str(e.new_string), streaming)),
      status,
      errorSummary: opts.errorSummary,
      partial: streaming,
    }
  }
  if (block.name === 'Write') {
    // Honest Write semantics (plan): no known before-state → pure
    // additions, never a fabricated diff.
    const content = str(input.content)
    const lines: DiffLine[] = content === '' ? [] : content.split('\n').map(text => ({ kind: '+' as const, text }))
    return {
      label: 'Write',
      files: [
        {
          path: str(input.file_path),
          verb: 'Writing',
          lines,
          additions: lines.length,
          deletions: 0,
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
    const lines: DiffLine[] = (content?.value ?? '') === ''
      ? []
      : content!.value.split('\n').map(text => ({ kind: '+' as const, text }))
    return {
      label: 'Write',
      files: [{ path: path.value, verb: 'Writing', lines, additions: lines.length, deletions: 0, streaming: true }],
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
