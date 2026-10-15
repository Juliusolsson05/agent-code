// A finished Codex `exec` script → the steps it ran and what each printed
// (#1510). Codex-PRIVATE, like command.ts.
//
// WHY this exists: modern Codex runs every tool from a JavaScript `exec`
// script, and the exact adapters (command.ts fromCodexCommandOperation /
// fromCodexCommandGroupOperation, embeddedOperation.ts) each admit only the
// script shapes whose result attribution they can PROVE. Measured over the
// owner's last 60 rollouts (1,566 scripts, 2026-10-14): the most common
// single-command shape, `text(await tools.exec_command({...}))`, was 22% of
// all scripts and admitted by none of them, and 65% of scripts call more
// than one tool. Every one of those fell to the generic fallback, which drew
// a finished command as RUNNING with its output hidden in a closed "JSON
// record · 5 keys" box ("is this user friendly? what even is this", owner).
//
// This adapter is the floor UNDER the exact adapters, not a replacement:
// dispatch tries it only after they decline. Its rules:
//   - It reads the result's REAL parts. Codex returns one part per text()
//     call; the rollout mapper joins them for every other consumer but
//     records each part's length (`codex.partLengths`, rollout.ts). The
//     first draft guessed boundaries from lines; review (#1518) showed that
//     split a JSONL dump into thousands of results, merged two pretty-printed
//     results, and missed the truncation header.
//   - A result is shown UNDER a step only when it is that step's kind of
//     record (a command record under `$`, an MCP result under `◆`) — in
//     order, or placed by the script's own index label (`{i, result}`).
//     Otherwise every result is listed under the steps, each with its own
//     verdict. Review found count-only pairing put one command's failure
//     under another.
//   - It declines (null) for: no result, a live row (the committed card
//     replaces it; and the live path re-renders without the committed
//     path's per-pair cache), apply_patch, a non-envelope result, a
//     `running` partial, an image part (the existing tool-result row paints
//     images and keeps each filename beside its image), an unknown part, or
//     an input too large to inspect on a render.
//   - It never claims what the result does not say: no verdict without an
//     exit code / error flag, and "completed" says only the JavaScript ran.
//   - `exactOutput` is the shared joined text exactly, so every byte stays
//     one click away when the result row is absorbed.
//
// The result grammar, measured over the same 60 rollouts:
//   part 0  "Script completed|failed|terminated\nWall time N seconds\nOutput:\n"
//   then one part per text() call, each one of:
//     - a serialized ExecCommandResult {output, exit_code?, session_id?, …}  (1,701)
//     - a Promise.allSettled wrapper of one {status, value|reason}, optionally
//       labelled {i}/{index}/{label} or nested {i, result|r}                    (~480)
//     - an MCP CallToolResult {content:[{type:'text',text}], isError?}        (218)
//     - plain text (cat of a file, a printed string)                         (226)
//     - `{}`                                                                  (86)
//     - an image part                                                         (11)
//   and, when Codex truncated the script's output, ONE part "Warning:
//   truncated output (original token count: N)\n…" holding the remaining
//   text() outputs joined by newlines (178): the only place lines are split.

import { codexExecScriptCalls, decodeDoubleQuotedLiteral, parseExecCommandArgument } from '@shared/codex/execScript'
import { asRecord } from '@shared/lib/asRecord'
import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'

import { codexTransportEnvelopeStatus } from '@providers/codex/renderer/adapters/command'
import { toolResultContentText } from '@providers/shared/renderer/rows/toolResultContent'

export type ScriptStepKind = 'command' | 'mcp' | 'stdin' | 'image' | 'web' | 'patch' | 'other'
export type ScriptStep = { kind: ScriptStepKind; title: string; detail: string }

export type ScriptResult =
  | { kind: 'command'; output: string; exitCode: number | null; sessionId: number | null; truncatedTokens: number | null; index: number | null }
  | { kind: 'mcp'; text: string; isError: boolean; index: number | null }
  | { kind: 'rejected'; text: string; index: number | null }
  | { kind: 'text'; text: string }
  | { kind: 'tools'; names: string[] }
  | { kind: 'json'; value: unknown }
  | { kind: 'script-error'; text: string }
  | { kind: 'empty' }

export type ScriptStepsModel = {
  steps: ScriptStep[]
  status: 'completed' | 'failed' | 'terminated'
  wallSeconds: number | null
  /** Codex cut the script's whole output to this many tokens; the model saw the same cut. */
  truncatedTokens: number | null
  results: ScriptResult[]
  /** results[i] belongs to steps[i] (kind-checked, see pairResults); else results list under the steps. */
  paired: boolean
  /** The transport text exactly as every other consumer reads it, for "View exact output". */
  exactOutput: string
}

/** Bounded like the other Codex adapters: generated scripts and outputs are untrusted sizes. */
const MAX_SCRIPT_CHARS = 256 * 1024
const MAX_OUTPUT_CHARS = 2 * 1024 * 1024

export function fromCodexScriptSteps(toolUse: ToolUseBlock, result: ToolResultBlock | null, options: { live?: boolean } = {}): ScriptStepsModel | null {
  if (toolUse.name !== 'exec' || !result || options.live === true) return null
  const script = scriptText(toolUse.input)
  if (script === null || script.length > MAX_SCRIPT_CHARS) return null
  if (/\btools\.apply_patch\s*\(/.test(script)) return null
  const parts = resultParts(result)
  if (!parts) return null
  if (parts.reduce((total, part) => total + part.length, 0) > MAX_OUTPUT_CHARS) return null
  const header = parts[0] ?? ''
  const status = codexTransportEnvelopeStatus(header)
  // `running` is a partial flush whose remaining output arrives later under
  // the same call id (command.ts commandResultEvidence); not a finished script.
  if (!status || status === 'running') return null
  const head = /^Script (?:completed|failed|running|terminated)[^\n]*\n(?:Wall time ([\d.]+) seconds\n)?(?:Output:\n)?/.exec(header)
  const steps = codexExecScriptCalls(script).map((call) => stepOf(call.tool, call.argument))

  // One entry per text() call. The header part may carry the first text()
  // output after "Output:\n" when the output was a single string.
  const outputs: string[] = []
  const afterHeader = head ? header.slice(head[0].length) : header
  if (afterHeader.trim()) outputs.push(afterHeader)
  outputs.push(...parts.slice(1))

  let truncatedTokens: number | null = null
  const results: ScriptResult[] = []
  for (const [position, text] of outputs.entries()) {
    if (!text.trim()) continue
    const warning = TRUNCATION.exec(text)
    if (warning) {
      // Codex folded the REMAINING text() outputs into this one part, joined
      // by newlines; a text() of an object is one JSON line, so here (only
      // here) a line that is a recognised record is its own result.
      truncatedTokens = Number(warning[1])
      for (const piece of splitTruncated(text.slice(warning[0].length))) results.push(piece)
      continue
    }
    // Codex's own "Script error:" report is the LAST part of a FAILED script;
    // anywhere else those words are a command's output (review A6).
    if (status !== 'completed' && position === outputs.length - 1 && /^\s*Script error:/.test(text)) {
      results.push({ kind: 'script-error', text: text.trim() })
      continue
    }
    if (isLabel(text)) continue
    results.push(...resultsOf(text))
  }
  const placed = pairResults(steps, results)
  return {
    steps,
    status,
    wallSeconds: head?.[1] ? Number(head[1]) : null,
    truncatedTokens,
    results: placed ?? results,
    paired: placed !== null,
    exactOutput: toolResultContentText(result.content),
  }
}

const TRUNCATION = /^\n?Warning: truncated output \(original token count: (\d+)\)\n(?:Total output lines: \d+\n)?\n?/

function scriptText(input: unknown): string | null {
  if (typeof input === 'string') return input
  const record = asRecord(input)
  // The rollout mapper stores a custom_tool_call's JavaScript as `{raw}`
  // (rollout.ts: it is not JSON, so parseCodexJson declines).
  for (const key of ['raw', 'input', 'script', 'code']) if (typeof record?.[key] === 'string') return record[key] as string
  return null
}

/**
 * The result's text parts, exactly. Null for anything else: an image part
 * (the existing row paints it beside its filename, review A2), an unknown
 * part, or a joined string whose recorded part lengths do not add up.
 */
function resultParts(result: ToolResultBlock): string[] | null {
  const content = result.content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const part of content) {
      const record = asRecord(part)
      if (typeof part === 'string') parts.push(part)
      else if (record && typeof record.text === 'string' && (record.type === 'text' || record.type === undefined)) parts.push(record.text)
      else return null
    }
    return parts
  }
  if (typeof content !== 'string') return null
  const lengths = asRecord(asRecord(result)?.codex)?.partLengths
  if (!Array.isArray(lengths) || !lengths.every((length) => Number.isInteger(length) && (length as number) >= 0)) return [content]
  // The mapper joined the parts with '\n' (entries.ts codexOutputText).
  const total = (lengths as number[]).reduce((sum, length) => sum + length, 0) + lengths.length - 1
  if (total !== content.length) return [content]
  const parts: string[] = []
  let offset = 0
  for (const length of lengths as number[]) {
    parts.push(content.slice(offset, offset + length))
    offset += length + 1
  }
  return parts
}

function firstString(argument: string | null): string {
  if (!argument) return ''
  const match = /"((?:[^"\\]|\\.)*)"/.exec(argument)
  if (match) return decodeDoubleQuotedLiteral(`"${match[1]}"`) ?? match[1]!
  // A command BUILT by the script (`cmd: \`nl -ba ${p}\``, usually inside a
  // .map over paths) cannot be decoded without running it. Its template is
  // the honest headline: what ran, with the variable part visible.
  const template = /`([^`]*)`/.exec(argument)
  return template ? template[1]! : ''
}

function stepOf(tool: string, argument: string | null): ScriptStep {
  if (tool === 'exec_command') {
    const parsed = argument ? parseExecCommandArgument(argument) : null
    return { kind: 'command', title: '$', detail: parsed?.command ?? firstString(argument) }
  }
  if (tool === 'write_stdin') {
    const session = argument ? /session_id\s*:\s*(\d+)/.exec(argument)?.[1] : undefined
    const chars = firstString(argument)
    return { kind: 'stdin', title: chars ? 'type into' : 'check on', detail: session ? `session ${session}${chars ? `: ${chars}` : ''}` : chars }
  }
  if (tool === 'view_image') return { kind: 'image', title: 'view image', detail: firstString(argument) }
  if (tool.startsWith('web__')) return { kind: 'web', title: tool.slice(5).replace(/_/g, ' '), detail: firstString(argument) }
  if (tool.startsWith('mcp__')) {
    const [, server, ...name] = tool.split('__')
    return { kind: 'mcp', title: name.join('__') || tool, detail: firstString(argument) || (server ?? '') }
  }
  return { kind: 'other', title: tool, detail: firstString(argument) }
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return { ok: false }
  try {
    return { ok: true, value: JSON.parse(trimmed) }
  } catch {
    return { ok: false }
  }
}

/** `text({i})` / `text("--- 2 ---")` only labels the next result; the order already carries it. */
function isLabel(text: string): boolean {
  const trimmed = text.trim()
  if (/^-{2,}\s*\d+\s*-{2,}$/.test(trimmed)) return true
  const parsed = parseJson(trimmed)
  if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) return false
  const value = parsed.value as Record<string, unknown>
  const keys = Object.keys(value)
  return keys.length > 0 && keys.every((key) => ['i', 'index', 'label', 'n'].includes(key)) && keys.every((key) => typeof value[key] !== 'object')
}

const EXEC_RESULT_KEYS = new Set(['output', 'chunk_id', 'wall_time_seconds', 'exit_code', 'original_token_count', 'session_id'])

/** The recognised records, and only those (review A11): never "any object with an output". */
function record(value: unknown, index: number | null = null): ScriptResult | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const entry = value as Record<string, unknown>
  // An ExecCommandResult: an `output` string and NOTHING but its own keys
  // (the vendored UnifiedExecCodeModeResult). A cat'd API response that
  // merely has an `output` field among others is not one (review A11).
  if (typeof entry.output === 'string' && Object.keys(entry).every((key) => EXEC_RESULT_KEYS.has(key))) {
    // exec_command applies its own max_output_tokens cut and says so in a
    // header INSIDE the output: a note, not command output.
    const cut = /^Warning: truncated output \(original token count: (\d+)\)\n(?:Total output lines: \d+\n)?\n?/.exec(entry.output)
    return {
      kind: 'command',
      output: cut ? entry.output.slice(cut[0].length) : entry.output,
      exitCode: typeof entry.exit_code === 'number' ? entry.exit_code : null,
      sessionId: typeof entry.session_id === 'number' ? entry.session_id : null,
      truncatedTokens: cut ? Number(cut[1]) : null,
      index,
    }
  }
  if (Array.isArray(entry.content) && entry.content.every((part) => part && typeof part === 'object' && 'type' in (part as object))) {
    const text = entry.content.map((part) => (typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : '')).join('\n')
    return { kind: 'mcp', text, isError: entry.isError === true, index }
  }
  // Promise.allSettled: {status, value|reason}.
  if (entry.status === 'fulfilled' && 'value' in entry) return record(entry.value, index)
  if (entry.status === 'rejected') {
    const reason = entry.reason
    return { kind: 'rejected', text: String((reason && typeof reason === 'object' ? (reason as { message?: unknown }).message : reason) ?? 'rejected'), index }
  }
  // A labelled wrapper: {i|index|label, result|r|value}.
  const label = typeof entry.i === 'number' ? entry.i : typeof entry.index === 'number' ? entry.index : null
  for (const key of ['result', 'r', 'value']) {
    if (key in entry && Object.keys(entry).length === 2) return record(entry[key], label ?? index)
  }
  return null
}

/** One text() output → its result(s). An array of records (Promise.all) is one result each (review B5). */
function resultsOf(text: string): ScriptResult[] {
  const parsed = parseJson(text)
  if (!parsed.ok) return [{ kind: 'text', text }]
  const value = parsed.value
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) return [{ kind: 'empty' }]
  const single = record(value)
  if (single) return [single]
  if (Array.isArray(value) && value.length > 0) {
    const many = value.map((item, index) => record(item, index))
    if (many.every((item): item is ScriptResult => item !== null)) return many
    // `text(ALL_TOOLS.filter(…))`: the agent reading its own tool catalogue
    // (79 results measured, kilobytes of descriptions each). What matters is
    // WHICH tools it looked up.
    if (value.every((item) => item && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string' && ('description' in (item as object) || 'doc' in (item as object)))) {
      return [{ kind: 'tools', names: value.map((item) => String((item as { name: string }).name).split('__').pop()!) }]
    }
  }
  if (typeof value === 'string') return [{ kind: 'text', text: value }]
  // The long tail of structure stays CLOSED behind a one-line summary.
  return [{ kind: 'json', value }]
}

/** The truncated part: recognised one-line records apart, every other run of lines one text block. */
function splitTruncated(body: string): ScriptResult[] {
  const out: ScriptResult[] = []
  let block: string[] = []
  const flush = () => {
    if (block.join('').trim()) out.push({ kind: 'text', text: block.join('\n') })
    block = []
  }
  for (const line of body.split('\n')) {
    const parsed = parseJson(line)
    const found = parsed.ok ? record(parsed.value) : null
    if (found) {
      flush()
      out.push(found)
    } else if (isLabel(line)) {
      flush()
    } else {
      block.push(line)
    }
  }
  flush()
  return out
}

const FITS: Record<ScriptStepKind, ReadonlySet<ScriptResult['kind']>> = {
  command: new Set(['command', 'rejected']),
  stdin: new Set(['command', 'rejected']),
  mcp: new Set(['mcp', 'rejected']),
  web: new Set(['mcp', 'text', 'json', 'rejected']),
  image: new Set(),
  patch: new Set(),
  other: new Set(),
}

/**
 * results[i] → steps[i], or null (list them under the steps instead).
 *
 * Only when every result is the KIND of record its step produces, so a
 * coincidence of counts can never show one step's output under another
 * (review A4: source order is not execution order, an unprinted step plus a
 * trailing text("done"), a fan-out printing failures first). When every
 * result carries the script's own index label (`{i, result}`), that index
 * places it; a fan-out printed out of order then still lines up.
 */
function pairResults(steps: ScriptStep[], results: ScriptResult[]): ScriptResult[] | null {
  if (results.length !== steps.length || steps.length === 0) return null
  if (results.some((result) => result.kind === 'script-error')) return null
  const indexed = results.every((result) => 'index' in result && result.index !== null)
  const ordered: ScriptResult[] = indexed ? new Array(steps.length) : [...results]
  if (indexed) {
    for (const result of results) {
      const index = (result as { index: number }).index
      if (index < 0 || index >= steps.length || ordered[index]) return null
      ordered[index] = result
    }
  }
  return ordered.every((result, at) => FITS[steps[at]!.kind].has(result.kind)) ? ordered : null
}
