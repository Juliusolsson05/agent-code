// Pure data extractors for Codex wire shapes — NO JSX. See the header
// of providers/claude/renderer/extractors.ts for why this seam exists.

import { asRecord } from '@shared/lib/asRecord'
import type { ToolResultBlock } from '@shared/types/transcript'

export type ExecCommandInput = {
  command: string
  workdir: string | null
  yieldTimeMs: number | null
  maxOutputTokens: number | null
}

/** Parse an exec_command tool_use input. Codex passes the command as
 *  `cmd` (string OR pre-split argv array) or `command`; the metadata
 *  keys ride alongside. Canonical home — CodexRows.tsx imports this
 *  (it used to own a private copy). */
export function execCommandInput(input: unknown): ExecCommandInput | null {
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

/** Codex exec metadata stamped on the tool_result block by the rollout
 *  mapper (codexToolResultEntry's `codex` extension — the source of
 *  truth is rollout.ts's exec_command_end branch). Claude has no
 *  equivalent; its results return nulls here. */
export function codexResultMeta(result: ToolResultBlock | null): {
  exitCode: number | null
  cwd: string | null
  durationMs: number | null
} {
  const meta = asRecord(result?.codex)
  if (!meta) return { exitCode: null, cwd: null, durationMs: null }
  return {
    exitCode: typeof meta.exitCode === 'number' ? meta.exitCode : null,
    cwd: typeof meta.cwd === 'string' ? meta.cwd : null,
    // Unified-exec wall time, captured when the output wrapper was
    // stripped (entries.ts stripUnifiedExecWrapper).
    durationMs: typeof meta.durationMs === 'number' ? meta.durationMs : null,
  }
}

/** Standalone patch_apply_end meta (unified-exec era: its call_id pairs
 *  with no tool_use — see rollout.ts). */
export function patchResultMeta(result: ToolResultBlock): {
  isPatchResult: boolean
  success: boolean
  files: string[]
  diffs: Record<string, string>
} {
  const meta = asRecord(result.codex)
  if (meta?.kind !== 'patch_apply_end') {
    return { isPatchResult: false, success: false, files: [], diffs: {} }
  }
  const files = Array.isArray(meta.files)
    ? meta.files.filter((f): f is string => typeof f === 'string')
    : []
  const diffsRec = asRecord(meta.diffs) ?? {}
  const diffs: Record<string, string> = {}
  for (const [k, v] of Object.entries(diffsRec)) {
    if (typeof v === 'string') diffs[k] = v
  }
  return { isPatchResult: true, success: meta.success === true, files, diffs }
}

/** Codex's exec classifier: parsed_cmd[0].type marks a command as a
 *  file read or search (the meta the old ExpandableCodeResult summary
 *  keyed on). */
export function parsedReadFromResult(
  result: ToolResultBlock | null,
): { kind: 'read' | 'search'; path: string | null } | null {
  const meta = asRecord(result?.codex)
  const parsedCmd = meta?.parsedCmd
  if (!Array.isArray(parsedCmd)) return null
  const first = asRecord(parsedCmd[0])
  const kind = first?.type
  if (kind !== 'read' && kind !== 'search') return null
  const path =
    typeof first?.path === 'string'
      ? first.path
      : typeof first?.name === 'string'
        ? first.name
        : null
  return { kind, path }
}

// ---------------------------------------------------------------------------
// apply_patch — Codex's `*** Begin Patch` grammar (NOT unified diff)
// ---------------------------------------------------------------------------
// Moved from CodexRows.tsx so the artifact resolvers can parse patches
// without importing JSX. The grammar: `*** Begin Patch`, then per file
// `*** (Add|Update|Delete) File: <path>` (+ optional `*** Move to:`),
// body lines prefixed +/-/space, `@@` section markers, `*** End Patch`.

import type { DiffLine } from '@shared/parsers/lineDiff'

export type ApplyPatchFile = {
  path: string
  action: 'Add' | 'Update' | 'Delete'
  movedTo?: string
  lines: DiffLine[]
}

export function applyPatchText(input: unknown): string {
  if (typeof input === 'string') return input
  const rec = asRecord(input)
  if (typeof rec?.raw === 'string') return rec.raw
  if (typeof rec?.arguments === 'string') return rec.arguments
  if (typeof rec?.cmd === 'string') return rec.cmd
  if (typeof rec?.patch === 'string') return rec.patch
  if (typeof rec?.input === 'string') return rec.input
  return ''
}

export function parseApplyPatch(input: unknown): ApplyPatchFile[] {
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
    } else if (rawLine === '') {
      // Models frequently emit blank context lines WITHOUT the leading
      // space; dropping them visually compressed rendered patches
      // (PR524 review).
      current.lines.push({ kind: 'ctx', text: '' })
    }
  }

  return files
}

/** Classify a unified diff (patch_apply_end error payloads carry one
 *  per file under codex.changes[path].unified_diff) into DiffLine[]
 *  for tinted rendering. Deliberately tiny: header/hunk lines are
 *  dropped, +/-/space prefixes map straight to line kinds — this is a
 *  display classifier, not a patch applier. */
export function unifiedDiffToLines(diff: string): DiffLine[] {
  const out: DiffLine[] = []
  for (const line of diff.split('\n')) {
    if (
      line.startsWith('diff --git') ||
      line.startsWith('index ') ||
      // Header forms carry a space (`+++ b/x`) — matching the bare
      // prefix dropped real content lines like a deletion of `--flag`
      // (arrives as `---flag`; PR524 review).
      line.startsWith('+++ ') ||
      line.startsWith('--- ') ||
      line === '+++' ||
      line === '---' ||
      line.startsWith('@@')
    ) {
      continue
    }
    if (line.startsWith('+')) out.push({ kind: '+', text: line.slice(1) })
    else if (line.startsWith('-')) out.push({ kind: '-', text: line.slice(1) })
    else out.push({ kind: 'ctx', text: line.startsWith(' ') ? line.slice(1) : line })
  }
  // Trim trailing blank ctx line a trailing \n produces.
  while (out.length > 0 && out[out.length - 1].kind === 'ctx' && out[out.length - 1].text === '') out.pop()
  return out
}

/** Per-file unified diffs from a patch_apply_end result's codex meta. */
export function patchChangesFromResult(
  result: ToolResultBlock | null,
): Array<{ path: string; lines: DiffLine[] }> {
  const meta = asRecord(result?.codex)
  const changes = asRecord(meta?.changes)
  if (!changes) return []
  return Object.entries(changes).map(([path, change]) => {
    const rec = asRecord(change)
    const diff = typeof rec?.unified_diff === 'string' ? rec.unified_diff : ''
    return { path, lines: diff ? unifiedDiffToLines(diff) : [] }
  })
}

// ---------------------------------------------------------------------------
// Live-partial apply_patch payloads (moved from BlockRow.tsx)
// ---------------------------------------------------------------------------
// While an apply_patch call streams, the payload may be a JSON wrapper
// whose patch text sits inside a STILL-OPEN string literal
// (`{"cmd": "*** Begin Patch\n..."`). JSON.parse can't touch it, so
// this decodes the partial string member by hand — same fixed-spec
// escape table as streamingWriteInput's scanner.

const SIMPLE_JSON_ESCAPES: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
}

function decodePartialJsonStringBody(raw: string, start: number): string {
  let out = ''
  let i = start
  while (i < raw.length) {
    const ch = raw[i]
    if (ch === '"') return out
    if (ch === '\\') {
      if (i + 1 >= raw.length) return out
      const esc = raw[i + 1]
      if (esc === 'u') {
        const hex = raw.slice(i + 2, i + 6)
        if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) return out
        out += String.fromCharCode(parseInt(hex, 16))
        i += 6
        continue
      }
      out += SIMPLE_JSON_ESCAPES[esc] ?? esc
      i += 2
      continue
    }
    out += ch
    i += 1
  }
  return out
}

function extractPartialJsonStringMember(raw: string, keys: string[]): string | null {
  for (const key of keys) {
    const marker = `"${key}"`
    const keyAt = raw.indexOf(marker)
    if (keyAt === -1) continue
    const colonAt = raw.indexOf(':', keyAt + marker.length)
    if (colonAt === -1) continue
    let valueAt = colonAt + 1
    while (valueAt < raw.length && /\s/.test(raw[valueAt] ?? '')) valueAt += 1
    if (raw[valueAt] !== '"') continue
    return decodePartialJsonStringBody(raw, valueAt + 1)
  }
  return null
}

/** Normalize a live (possibly partial) apply_patch buffer into the
 *  `{ raw: <patch grammar> }` shape parseApplyPatch understands —
 *  bare grammar, complete JSON wrapper, or partial JSON wrapper. */
export function partialApplyPatchInput(raw: string): Record<string, unknown> {
  // Bare grammar ONLY when the buffer actually starts with the patch
  // header. `includes` alone fires on a JSON wrapper whose ESCAPED
  // patch contains the marker literally (`{"cmd": "*** Begin Patch\n…`),
  // returning the escaped buffer — whose newlines are two-char \n
  // sequences parseApplyPatch can't split on — and making the partial
  // string-member decode below unreachable (found by PR524 review).
  if (raw.trimStart().startsWith('*** Begin Patch')) return { raw }
  const patch = extractPartialJsonStringMember(raw, [
    'cmd',
    'patch',
    'input',
    'raw',
    'arguments',
  ])
  return patch && patch.includes('*** Begin Patch') ? { raw: patch } : { raw, arguments: raw }
}

// ---------------------------------------------------------------------------
// Unified exec — Codex's modern `exec` tool (custom_tool_call, name "exec")
// ---------------------------------------------------------------------------
// The input is not JSON: it is a JavaScript SCRIPT the model writes, e.g.
//   const r = await tools.exec_command({"cmd":"sed -n '1,40p' x.ts", ...});
//   text(r.output);
// or
//   const patch = "*** Begin Patch\n*** Update File: x.ts\n@@\n-a\n+b\n*** End Patch";
//   text(await tools.apply_patch(patch));
// Codex's own TUI renders the script's INTENT ("Edited x.ts (+7 -3)");
// rendering the raw script as a generic card is exactly the regression a
// 2026-07-12 debug bundle caught. This classifier extracts the intent so
// the artifact layer can route to DiffCard / CommandCard. It must be
// PARTIAL-SAFE: the script streams, so the embedded string literal /
// JSON argument may be unterminated at any prefix.

export type UnifiedExecAction =
  | { kind: 'apply_patch'; patchText: string }
  | { kind: 'exec_command'; input: ExecCommandInput }
  | { kind: 'write_stdin'; chars: string }
  /** tools.wait(...) — waiting on a background terminal session. */
  | { kind: 'wait' }
  | null

/** Decode a JS double-quoted string literal starting just AFTER the
 *  opening quote, tolerating an unterminated (still-streaming) tail.
 *  JS escapes overlap JSON's for everything models emit here. */
function decodeJsStringLiteral(script: string, start: number): string {
  return decodePartialJsonStringBody(script, start)
}

/** Extract the first balanced {...} JSON object argument following
 *  `marker` in the script, searching from `from`. Returns the parsed
 *  object when complete; null while the braces are still streaming
 *  (caller falls back to partial string-member extraction). Brace
 *  matching skips string literals so a "}" inside a cmd string can't
 *  end the scan early. */
function jsonObjectArgAfter(
  script: string,
  marker: string,
  from = 0,
): Record<string, unknown> | null {
  const at = script.indexOf(marker, from)
  if (at === -1) return null
  const open = script.indexOf('{', at + marker.length)
  if (open === -1) return null
  let depth = 0
  let inString = false
  for (let i = open; i < script.length; i++) {
    const ch = script[i]
    if (inString) {
      if (ch === '\\') i += 1
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          return JSON.parse(script.slice(open, i + 1)) as Record<string, unknown>
        } catch {
          return null
        }
      }
    }
  }
  return null
}

export function classifyUnifiedExecScript(script: string): UnifiedExecAction {
  if (!script) return null

  // apply_patch first: an edit is the story even if the script also
  // echoes output. The patch text lives in a string literal (either
  // inline in the call or bound to a const) — find the literal that
  // contains the patch header and decode it, partial-safe.
  if (script.includes('tools.apply_patch')) {
    const headerAt = script.indexOf('*** Begin Patch')
    if (headerAt !== -1) {
      const quoteAt = script.lastIndexOf('"', headerAt)
      if (quoteAt !== -1) {
        const patchText = decodeJsStringLiteral(script, quoteAt + 1)
        if (patchText.includes('*** Begin Patch')) {
          return { kind: 'apply_patch', patchText }
        }
      }
    }
    // Header hasn't streamed in yet — signal apply_patch with an empty
    // patch so the card can show its header instead of a raw script.
    return { kind: 'apply_patch', patchText: '' }
  }

  if (script.includes('tools.wait(')) {
    return { kind: 'wait' }
  }

  if (script.includes('tools.write_stdin')) {
    const arg = jsonObjectArgAfter(script, 'tools.write_stdin')
    const chars =
      typeof arg?.chars === 'string'
        ? arg.chars
        : extractPartialJsonStringMember(script, ['chars']) ?? ''
    // Empty stdin IS a wait: Codex polls a background terminal with
    // chars:"" while output drains, and its native TUI renders exactly
    // these as "Waited for background terminal".
    if (chars === '') return { kind: 'wait' }
    return { kind: 'write_stdin', chars }
  }

  if (script.includes('tools.exec_command')) {
    // Collect EVERY exec_command call in the script — Promise.all
    // fan-outs run several commands from one script, and the native
    // TUI shows one cell per inner call. We render them as command
    // lines in one card (the rollout gives us one tool_use to hang
    // them on), which reads the same.
    const inputs: ExecCommandInput[] = []
    let from = 0
    for (;;) {
      const at = script.indexOf('tools.exec_command', from)
      if (at === -1) break
      const arg = jsonObjectArgAfter(script, 'tools.exec_command', at)
      const parsed = arg ? execCommandInput(arg) : null
      if (parsed) inputs.push(parsed)
      from = at + 'tools.exec_command'.length
    }
    if (inputs.length > 0) {
      const first = inputs[0]
      const input: ExecCommandInput =
        inputs.length === 1
          ? first
          : {
              ...first,
              command: inputs.map(i => i.command).join('\n'),
            }
      return { kind: 'exec_command', input }
    }
    // Partial braces: pull what has streamed so far (cmd is the one
    // that matters for the header; the metadata chips fill in later).
    const cmd = extractPartialJsonStringMember(script, ['cmd', 'command'])
    if (cmd !== null) {
      return {
        kind: 'exec_command',
        input: { command: cmd, workdir: null, yieldTimeMs: null, maxOutputTokens: null },
      }
    }
    return { kind: 'exec_command', input: { command: '…', workdir: null, yieldTimeMs: null, maxOutputTokens: null } }
  }

  return null
}

/** The unified-exec script text from a tool input, both planes:
 *  committed rollout synthesis wraps the non-JSON script as { raw };
 *  the live plane hands the raw argumentsJson buffer straight in. */
export function unifiedExecScript(input: unknown): string {
  if (typeof input === 'string') return input
  const rec = asRecord(input)
  if (typeof rec?.raw === 'string') return rec.raw
  if (typeof rec?.input === 'string') return rec.input
  return ''
}
