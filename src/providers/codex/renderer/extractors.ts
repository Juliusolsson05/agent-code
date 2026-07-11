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
} {
  const meta = asRecord(result?.codex)
  if (!meta) return { exitCode: null, cwd: null }
  return {
    exitCode: typeof meta.exitCode === 'number' ? meta.exitCode : null,
    cwd: typeof meta.cwd === 'string' ? meta.cwd : null,
  }
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
      line.startsWith('+++') ||
      line.startsWith('---') ||
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
  if (raw.includes('*** Begin Patch')) return { raw }
  const patch = extractPartialJsonStringMember(raw, [
    'cmd',
    'patch',
    'input',
    'raw',
    'arguments',
  ])
  return patch && patch.includes('*** Begin Patch') ? { raw: patch } : { raw, arguments: raw }
}
