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
// dispatch tries it only after they decline. It never claims what a step's
// exit code was unless the result says so, and it never drops a byte: every
// result part is shown (unknown structure as a closed one-line summary), and
// the exact transport text stays one click away (`exactOutput`).
//
// The result grammar, measured over the same 60 rollouts (2026-10-14):
//   part 0  "Script completed|failed|running|terminated\nWall time N seconds\nOutput:\n"
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
//   text() outputs joined by newlines (178).
// Run over every one of those 1,565 results this model yields 3,176 results
// and no raw JSON shown open (scriptSteps.test.ts pins the recorded sample).

import { codexExecScriptCalls, decodeDoubleQuotedLiteral, parseExecCommandArgument } from '@shared/codex/execScript'
import { asRecord } from '@shared/lib/asRecord'
import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'

import { codexTransportEnvelopeStatus } from '@providers/codex/renderer/adapters/command'

export type ScriptStepKind = 'command' | 'mcp' | 'stdin' | 'image' | 'web' | 'patch' | 'other'
export type ScriptStep = { kind: ScriptStepKind; title: string; detail: string }

export type ScriptResult =
  | { kind: 'command'; output: string; exitCode: number | null; sessionId: number | null; truncatedTokens: number | null }
  | { kind: 'mcp'; text: string; isError: boolean }
  | { kind: 'rejected'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'tools'; names: string[] }
  | { kind: 'json'; value: unknown }
  | { kind: 'script-error'; text: string }
  | { kind: 'empty' }
  | { kind: 'image' }

export type ScriptStepsModel = {
  steps: ScriptStep[]
  status: 'completed' | 'failed' | 'running' | 'terminated'
  wallSeconds: number | null
  /** Codex cut the script's whole output to this many tokens; the model saw the same cut. */
  truncatedTokens: number | null
  results: ScriptResult[]
  /** True when result i is step i's (one text() per call, in order); else results list under the steps. */
  paired: boolean
  /** The transport text exactly as recorded, for "View exact output". */
  exactOutput: string
}

/** Bounded like the other Codex adapters: generated scripts and outputs are untrusted sizes. */
const MAX_SCRIPT_CHARS = 256 * 1024
const MAX_OUTPUT_CHARS = 2 * 1024 * 1024

/**
 * Admit a finished `exec` script no exact adapter owned. Null (decline) for:
 * no result yet (the live headline stays command.ts's), an apply_patch
 * script (codeEdit owns the mutation evidence), a result without Codex's
 * transport header (not an exec envelope: leave it to the fallback), or one
 * too large to inspect synchronously on a render.
 */
export function fromCodexScriptSteps(toolUse: ToolUseBlock, result: ToolResultBlock | null): ScriptStepsModel | null {
  if (toolUse.name !== 'exec' || !result) return null
  const script = scriptText(toolUse.input)
  if (script === null || script.length > MAX_SCRIPT_CHARS) return null
  if (/\btools\.apply_patch\s*\(/.test(script)) return null
  const parts = resultParts(result.content)
  if (parts.reduce((total, part) => total + (part.text?.length ?? 0), 0) > MAX_OUTPUT_CHARS) return null
  const header = parts[0]?.type === 'text' ? parts[0].text ?? '' : ''
  const status = codexTransportEnvelopeStatus(header)
  // `running` is a partial flush whose remaining output arrives later under
  // the same call id (command.ts commandResultEvidence); not a finished script.
  if (!status || status === 'running') return null
  const head = /^Script (?:completed|failed|running|terminated)[^\n]*\n(?:Wall time ([\d.]+) seconds\n)?(?:Output:\n)?/.exec(header)
  const steps = codexExecScriptCalls(script).map((call) => stepOf(call.tool, call.argument))

  let truncatedTokens: number | null = null
  const texts: string[] = []
  const results: ScriptResult[] = []
  const rest = head ? [{ type: 'text', text: header.slice(head[0].length) }, ...parts.slice(1)] : parts
  for (const part of rest) {
    if (part.type === 'image') {
      results.push({ kind: 'image' })
      continue
    }
    const text = part.text ?? ''
    if (!text.trim()) continue
    const warning = TRUNCATION.exec(text)
    if (warning) truncatedTokens = Number(warning[1])
    // One line stream for every text part: the app's rollout mapper joins a
    // text-only output array with '\n' (entries.ts codexOutputText), and
    // Codex folds a truncated script's text() outputs into one part the same
    // way. A text() of an OBJECT is one JSON line, so a line that parses as
    // JSON on its own is its own result; every run of other lines is ONE
    // block. (Splitting every line, the first draft, turned 1,565 scripts
    // into 14,546 "results".)
    splitLines(warning ? text.slice(warning[0].length) : text, texts)
    continue
  }
  for (const text of texts) {
    // `text({i})` / `text("--- 2 ---")` before each result only labels the
    // next one; the results are already in order.
    if (isLabel(text)) continue
    // A failed script ends with Codex's own "Script error:" report: about
    // the SCRIPT, never the step whose slot it would fill by position.
    if (/^\s*Script error:/.test(text)) results.push({ kind: 'script-error', text: text.trim() })
    else results.push(resultOf(text))
  }
  const stepResults = results.filter((entry) => entry.kind !== 'script-error')
  const images = results.filter((entry) => entry.kind === 'image').length
  const paired = !results.some((entry) => entry.kind === 'script-error')
    && (stepResults.length === steps.length || stepResults.length - images === steps.length)
  return {
    steps,
    status,
    wallSeconds: head?.[1] ? Number(head[1]) : null,
    truncatedTokens,
    results,
    paired,
    exactOutput: parts.map((part) => (part.type === 'image' ? '[image]' : part.text ?? '')).join(''),
  }
}

function splitLines(body: string, into: string[]): void {
  let block: string[] = []
  const flush = () => {
    if (block.join('').trim()) into.push(block.join('\n'))
    block = []
  }
  for (const line of body.split('\n')) {
    // A failed script's "Script error:" report is Codex's own part; after the
    // mapper's '\n' join it would merge into the text above it.
    if (/^Script error:/.test(line)) flush()
    if (parsesAsJson(line.trim())) {
      flush()
      into.push(line.trim())
    } else {
      block.push(line)
    }
  }
  flush()
}

const TRUNCATION = /^Warning: truncated output \(original token count: (\d+)\)\n(?:Total output lines: \d+\n)?\n?/

function scriptText(input: unknown): string | null {
  if (typeof input === 'string') return input
  const record = asRecord(input)
  // The rollout mapper stores a custom_tool_call's JavaScript as `{raw}`
  // (rollout.ts: it is not JSON, so parseCodexJson declines).
  for (const key of ['raw', 'input', 'script', 'code']) if (typeof record?.[key] === 'string') return record[key] as string
  return null
}

type ResultPart = { type: 'text' | 'image'; text?: string }

function resultParts(content: unknown): ResultPart[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (!Array.isArray(content)) return []
  return content.flatMap((part): ResultPart[] => {
    const record = asRecord(part)
    if (!record) return []
    if (typeof record.text === 'string') return [{ type: 'text' as const, text: record.text }]
    if (record.type === 'image' || record.type === 'input_image') return [{ type: 'image' as const }]
    return []
  })
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

function parsesAsJson(text: string): boolean {
  if (!text.startsWith('{') && !text.startsWith('[')) return false
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

function isLabel(text: string): boolean {
  const trimmed = text.trim()
  if (/^-{2,}\s*\d+\s*-{2,}$/.test(trimmed)) return true
  if (!trimmed.startsWith('{')) return false
  try {
    const value = JSON.parse(trimmed) as Record<string, unknown>
    const keys = Object.keys(value)
    return keys.length > 0 && keys.every((key) => ['i', 'index', 'label', 'name', 'n'].includes(key)) && keys.every((key) => typeof value[key] !== 'object')
  } catch {
    return false
  }
}

function unwrap(value: unknown): ScriptResult {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    if (Object.keys(record).length === 0) return { kind: 'empty' }
    if (typeof record.output === 'string') {
      // exec_command applies its own max_output_tokens cut and says so in a
      // header INSIDE the output: a note, not command output.
      const cut = TRUNCATION.exec(record.output)
      return {
        kind: 'command',
        output: cut ? record.output.slice(cut[0].length) : record.output,
        exitCode: typeof record.exit_code === 'number' ? record.exit_code : null,
        sessionId: typeof record.session_id === 'number' ? record.session_id : null,
        truncatedTokens: cut ? Number(cut[1]) : null,
      }
    }
    if (Array.isArray(record.content)) {
      const text = record.content.map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : '')).join('\n')
      return { kind: 'mcp', text, isError: record.isError === true }
    }
    if (record.status === 'rejected') {
      const reason = record.reason
      return { kind: 'rejected', text: String((reason && typeof reason === 'object' ? (reason as { message?: unknown }).message : reason) ?? 'rejected') }
    }
    for (const key of ['value', 'result', 'r']) if (key in record) return unwrap(record[key])
  }
  // `text(ALL_TOOLS.filter(…))`: the agent reading its own tool catalogue
  // (79 results in the measured rollouts, kilobytes of descriptions each).
  // What matters is WHICH tools it looked up.
  if (Array.isArray(value) && value.length > 0 && value.every((item) => item && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string' && ('description' in (item as object) || 'doc' in (item as object)))) {
    return { kind: 'tools', names: value.map((item) => String((item as { name: string }).name).split('__').pop()!) }
  }
  if (typeof value === 'string') return { kind: 'text', text: value }
  // Anything else stays CLOSED behind a one-line summary in the card: the
  // long tail of structure, never an open dump.
  return { kind: 'json', value }
}

/** The readable string inside a JSON line Codex cut mid-way (head + tail truncation). */
function cutJsonText(text: string): string | null {
  const match = /"(?:output|text)"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(text)
  if (!match) return null
  const decoded = decodeDoubleQuotedLiteral(`"${match[1]!.replace(/\\u[0-9a-fA-F]{0,3}$|\\$/, '')}"`)
  // An MCP payload is often JSON-in-a-string: decode one more level.
  return decoded !== null && decoded.startsWith('{"') ? cutJsonText(decoded) ?? decoded : decoded
}

function resultOf(text: string): ScriptResult {
  const trimmed = text.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return unwrap(JSON.parse(trimmed))
    } catch {
      // A catalogue cut mid-way by truncation: the names are still readable.
      if (/^\[\s*\{\s*"name"\s*:/.test(trimmed)) {
        return { kind: 'tools', names: [...trimmed.matchAll(/"name"\s*:\s*"([^"]+)"/g)].map((m) => m[1]!.split('__').pop()!) }
      }
      const salvaged = cutJsonText(trimmed)
      if (salvaged !== null) return { kind: 'text', text: `${salvaged}\n…` }
    }
  }
  return trimmed ? { kind: 'text', text } : { kind: 'empty' }
}
