import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'
import { asRecord } from '@shared/lib/asRecord'
import { boundedTextPage } from '@renderer/lib/text/boundedText'
import type { DiffLine } from '@shared/parsers/lineDiff'
import type {
  CodeEditFile,
  CodeEditRenderModel,
} from '@providers/shared/renderer/protocols/code-edit/model'

// Codex wire → CodeEditRenderModel (renderer rewrite, PR #555; Phase 5
// adapter). Codex-PRIVATE — parses the apply_patch envelope (classic and
// the raw streaming text) plus patch_apply_end results; Claude never
// appears here. Reuses the battle-tested parseApplyPatch from CodexRows
// rather than a second patch parser (one decoder per wire shape, ever).
//
// STREAMING-FIRST: parseApplyPatch is prefix-tolerant by construction — a
// partial patch body simply yields the files/hunks streamed SO FAR, so a
// model exists from the moment `*** Begin Patch` + the first file header
// arrive. The trap this kills: waiting for the full JSON/patch to land
// before rendering anything (which reduces streaming to a spinner).

// ---- apply_patch parser (MOVED here from CodexRows.tsx, PR #555 Phase 5):
// the adapter is the parser's home — rows import FROM the adapter, never the
// reverse, keeping the graph acyclic (rows -> adapter -> shared protocol).
export type ApplyPatchFile = {
  path: string
  action: 'Add' | 'Update' | 'Delete'
  movedTo?: string
  lines: DiffLine[]
}

function rawPatchInputText(input: unknown): string {
  if (typeof input === 'string') return input
  const rec = asRecord(input)
  if (typeof rec?.raw === 'string') return rec.raw
  if (typeof rec?.arguments === 'string') return rec.arguments
  if (typeof rec?.cmd === 'string') return rec.cmd
  if (typeof rec?.patch === 'string') return rec.patch
  if (typeof rec?.input === 'string') return rec.input
  return ''
}

export function applyPatchText(input: unknown): string {
  const direct = rawPatchInputText(input)
  // MODERN UNIFIED-EXEC WRAPPER (first caught in the wild 2026-07-16, the
  // corpus's documented #1 gap): the patch arrives EMBEDDED in a JS script —
  //   const patch = "*** Begin Patch\n*** Add File: …"; await tools.apply_patch(patch)
  // The sentinel text is present but the newlines are \n ESCAPES inside a
  // string literal, so the line-based parser sees one giant line and bails.
  // Detect that case and decode the containing literal (prefix-tolerant: an
  // unterminated literal mid-stream decodes to the patch streamed so far —
  // streaming-first holds for wrapped patches too).
  if (direct.includes('*** Begin Patch') && !direct.includes('*** Begin Patch\n')) {
    const embedded = decodeEmbeddedPatchLiteral(direct)
    if (embedded) return embedded
  }
  return direct
}

/** Prove that a tool invocation owns apply-patch rendering. Sentinel text is
 * insufficient for unified exec: documentation/tests may contain a patch
 * literal without ever invoking the tool. Requiring the Agent Code wrapper's
 * call site keeps those scripts on the generic/command path. */
export function isCodexApplyPatchUse(
  block: ToolUseBlock,
  opts: { streamingPrefix?: boolean } = {},
): boolean {
  if (block.name === 'apply_patch') return true
  if (block.name !== 'exec') return false
  const script = rawPatchInputText(block.input)
  const hasPatch = applyPatchText(block.input).includes('*** Begin Patch')
  // Unified exec streams the patch literal before the later call expression.
  // Admit that prefix only while lifecycle evidence says the script is still
  // incomplete; a completed script must prove the actual tools.apply_patch
  // invocation or it falls back.
  return hasPatch && (/\btools\.apply_patch\s*\(/.test(script) || opts.streamingPrefix === true)
}

/** Find the JS string literal containing the patch sentinel and decode its
 *  escapes. Exported for tests. Returns null when the sentinel is absent or
 *  the literal cannot be located. */
export function decodeEmbeddedPatchLiteral(script: string): string | null {
  const at = script.indexOf('*** Begin Patch')
  if (at === -1) return null
  // Scan BACK to the opening quote of the containing literal (an unescaped
  // " or '). The patch producer uses double quotes; tolerate both.
  let open = -1
  let quote = '"'
  for (let i = at - 1; i >= 0; i--) {
    const c = script[i]
    if ((c === '"' || c === "'") && script[i - 1] !== '\\') {
      open = i
      quote = c
      break
    }
  }
  if (open === -1) return null
  let out = ''
  for (let i = open + 1; i < script.length; i++) {
    const c = script[i]
    if (c === '\\') {
      const n = script[i + 1]
      if (n === undefined) break // torn escape mid-stream — prefix ends here
      if (n === 'n') out += '\n'
      else if (n === 't') out += '\t'
      else if (n === 'r') out += '\r'
      else out += n // covers \" \' \\ and anything exotic
      i += 1
      continue
    }
    if (c === quote) break // literal closed — full patch decoded
    out += c
  }
  return out.includes('*** Begin Patch') ? out : null
}

export function parseApplyPatch(input: unknown): ApplyPatchFile[] {
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

const VERB = { Add: 'Creating', Update: 'Editing', Delete: 'Deleting' } as const

function toFiles(input: unknown, streaming: boolean): CodeEditFile[] {
  return parseApplyPatch(input).map(f => ({
    path: f.movedTo ? `${f.path} → ${f.movedTo}` : f.path,
    verb: f.movedTo ? 'Moving' : VERB[f.action],
    lines: f.lines,
    additions: f.lines.filter(l => l.kind === '+').length,
    deletions: f.lines.filter(l => l.kind === '-').length,
    streaming,
  }))
}

export function fromCodexApplyPatch(
  block: ToolUseBlock,
  opts: { streaming?: boolean; running?: boolean; result?: ToolResultBlock | null } = {},
): CodeEditRenderModel | null {
  if (!isCodexApplyPatchUse(block, { streamingPrefix: opts.streaming === true })) return null
  const files = toFiles(block.input, opts.streaming === true)
  // No recognizable patch yet (input still streaming its preamble, or an
  // unexpected wrapper): decline — the caller's fallback stays visible.
  // The `*** Begin Patch` sentinel is what makes intent provable ASAP.
  if (files.length === 0) return null
  const failed = opts.result?.is_error === true
  return {
    label: 'apply_patch',
    files,
    status: failed
      ? 'failure'
      : opts.result
        ? 'success'
        : opts.streaming
          ? 'streaming'
          : opts.running
            ? 'running'
            : 'success',
    errorSummary: failed
      ? firstLine(opts.result)
      : undefined,
    partial: opts.streaming === true,
  }
}

/** Raw streaming patch TEXT (unified-exec/live plane) → model ASAP. */
export function fromCodexPartialPatchText(rawPatch: string): CodeEditRenderModel | null {
  return fromCodexApplyPatch({ type: 'tool_use', id: '', name: 'apply_patch', input: { input: rawPatch } } as ToolUseBlock, {
    streaming: true,
  })
}

function firstLine(result: ToolResultBlock | null | undefined): string | undefined {
  const c = result?.content
  const text = typeof c === 'string' ? c : Array.isArray(c) ? String((c[0] as { text?: unknown })?.text ?? '') : ''
  return text ? text.split('\n')[0].slice(0, 200) : 'patch failed'
}
