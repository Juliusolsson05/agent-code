import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'
import { asRecord } from '@shared/lib/asRecord'
import {
  boundedTextPage,
  TEXT_PAGE_MAX_CHARS,
} from '@renderer/lib/text/boundedText'
import type { CommandRenderModel } from '@providers/shared/renderer/protocols/command/model'
import { analyzeCommandOutput } from '@providers/shared/renderer/protocols/command/formatters'
import { toolResultContentText } from '@providers/shared/renderer/rows/toolResultContent'

// Codex wire → CommandRenderModel (PR #555 Phase 6). Codex-PRIVATE. Covers
// classic exec_command AND the modern unified-exec script wrapper's plain-
// command case (patch scripts are claimed FIRST by the codeEdit adapter —
// #524 history: classify apply_patch before embedded commands, or edits
// regress into command output). The execCommandInput helpers MOVED here
// from CodexRows.tsx — rows import FROM the adapter, keeping the graph
// acyclic, same as parseApplyPatch.

export const MAX_COMMAND_DISPLAY_LINES = 2
export const MAX_COMMAND_DISPLAY_CHARS = 160
type ExecCommandInput = {
  command: string
  workdir: string | null
  yieldTimeMs: number | null
  maxOutputTokens: number | null
}

type UnifiedResultPresentation = 'direct-output' | 'serialized-result' | 'discarded'

export type CodexCommandOperation = {
  /** Full command is retained for semantic formatters. The leaf view receives
   * the independently bounded command in `model.command`. */
  rawCommand: string
  model: CommandRenderModel
  /** Only true when the adapter proved where every visible result byte lives.
   * The operation boundary may absorb the paired result only in this state. */
  ownsResult: boolean
}

type TransparentExecInvocation = {
  command: string
  workdir: string | null
  yieldTimeMs: number | null
  maxOutputTokens: number | null
  presentation: UnifiedResultPresentation
}

type CommandResultEvidence = {
  output?: string
  exitCode: number | null
  failed: boolean
  owned: boolean
}

const SERIALIZED_EXEC_RESULT_MAX_CHARS = 2 * 1024 * 1024

/** Full command for semantic formatters; display adapters use the bounded
 * sibling below. Never feed this unbounded string directly to a headline. */
export function rawCodexExecCommand(input: unknown): string | null {
  const rec = asRecord(input)
  const raw = rec?.cmd ?? rec?.command
  if (typeof raw === 'string') return /\S/.test(raw) ? raw : null
  if (Array.isArray(raw) && raw.every(part => typeof part === 'string')) {
    const command = raw.join(' ')
    return /\S/.test(command) ? command : null
  }
  return null
}

export function execCommandInput(input: unknown): ExecCommandInput | null {
  const rec = asRecord(input)
  if (!rec) return null
  const rawCommand = rec.cmd ?? rec.command
  const command = Array.isArray(rawCommand)
    ? boundedCommandParts(rawCommand)
    : typeof rawCommand === 'string'
      ? truncateCommand(rawCommand)
      : ''
  if (!/\S/.test(command)) return null
  return {
    command,
    workdir: typeof rec.workdir === 'string' ? rec.workdir : null,
    yieldTimeMs: typeof rec.yield_time_ms === 'number' ? rec.yield_time_ms : null,
    maxOutputTokens:
      typeof rec.max_output_tokens === 'number' ? rec.max_output_tokens : null,
  }
}

export function boundedCommandParts(parts: readonly unknown[]): string {
  let command = ''
  for (const part of parts) {
    const separator = command ? ' ' : ''
    const remaining = MAX_COMMAND_DISPLAY_CHARS - command.length - separator.length
    if (remaining <= 0) return `${command}…`
    const page = boundedTextPage(String(part), 0, remaining, MAX_COMMAND_DISPLAY_LINES)
    command += separator + page.text
    if (page.hasNext) return `${command}…`
  }
  // WHY the join is built only to the display budget: command arrays are provider data, not a
  // trusted argv size. Array.map(String).join(' ') used to materialize every argument before the
  // two-line card truncated it. The transcript remains the complete tool-call source; this helper
  // owns only the deliberately compact activity headline.
  return truncateCommand(command)
}

export function truncateCommand(text: string): string {
  const page = boundedTextPage(
    text,
    0,
    MAX_COMMAND_DISPLAY_CHARS,
    MAX_COMMAND_DISPLAY_LINES,
  )
  if (!page.hasNext) return text
  return page.text.trimEnd() + '…'
}


export function fromCodexExecCommand(
  block: ToolUseBlock,
  opts: {
    streaming?: boolean
    live?: boolean
    result?: ToolResultBlock | null
  } = {},
): CommandRenderModel | null {
  return fromCodexCommandOperation({
    toolUse: block,
    result: opts.result ?? null,
    streaming: opts.streaming,
    live: opts.live,
  })?.model ?? null
}

/**
 * Normalize both Codex command transports into one operation contract.
 *
 * Native `exec_command` is already a command envelope. Modern Codex instead
 * emits a `custom_tool_call(name="exec")` whose JavaScript calls
 * `tools.exec_command`. We admit the latter only when the complete script is a
 * transparent one-call bridge and its trailing `text(...)` expression proves
 * whether the result is direct output or a serialized ExecCommandResult.
 *
 * WHY this proof belongs here rather than in Git or another formatter: Git,
 * test totals, JSON, file mutations, failures, ANSI output, and every future
 * command family all consume the same operation. Teaching each formatter
 * about Codex JavaScript would duplicate a provider transport grammar and
 * guarantee drift. Conversely, treating every script containing the substring
 * `tools.exec_command` as transparent could absorb unrelated JavaScript output.
 */
export function fromCodexCommandOperation(input: {
  toolUse: ToolUseBlock
  result: ToolResultBlock | null
  streaming?: boolean
  live?: boolean
}): CodexCommandOperation | null {
  const native = input.toolUse.name === 'exec_command'
    ? nativeExecInvocation(input.toolUse.input)
    : null
  const unified = input.toolUse.name === 'exec'
    ? transparentExecInvocation(input.toolUse.input)
    : null
  const invocation = native ?? unified
  if (!invocation) return null

  const evidence = commandResultEvidence(
    input.result,
    native ? 'native' : invocation.presentation,
  )
  const meta: string[] = []
  if (invocation.yieldTimeMs !== null) meta.push(`yield ${invocation.yieldTimeMs}ms`)
  if (invocation.maxOutputTokens !== null) meta.push(`max ${invocation.maxOutputTokens} tok`)
  const lifecycle = commandLifecycle({
    result: input.result,
    evidence,
    streaming: input.streaming,
  })
  const analyzed = evidence.output !== undefined && input.result
    ? analyzeCommandOutput(invocation.command, evidence.output, evidence.exitCode)
    : null

  return {
    rawCommand: invocation.command,
    ownsResult: input.result !== null && evidence.owned,
    model: {
      label: 'exec',
      command: truncateCommand(invocation.command),
      cwd: invocation.workdir ?? undefined,
      status: lifecycle.status,
      exitCode: evidence.exitCode,
      ...(evidence.output !== undefined ? { output: evidence.output } : {}),
      ...(evidence.failed ? { outputIsError: true } : {}),
      errorSummary: lifecycle.errorSummary,
      conclusion: analyzed ?? (meta.length > 0 ? meta.join(' · ') : undefined),
    },
  }
}

function nativeExecInvocation(input: unknown): TransparentExecInvocation | null {
  const rawCommand = rawCodexExecCommand(input)
  const parsed = execCommandInput(input)
  if (!rawCommand || !parsed) return null
  return {
    command: rawCommand,
    workdir: parsed.workdir,
    yieldTimeMs: parsed.yieldTimeMs,
    maxOutputTokens: parsed.maxOutputTokens,
    presentation: 'direct-output',
  }
}

function transparentExecInvocation(input: unknown): TransparentExecInvocation | null {
  const script = applyPatchScriptText(input)
  if (!script || script.length > TEXT_PAGE_MAX_CHARS) return null
  if (/\btools\.apply_patch\s*\(/.test(script)) return null

  const marker = 'tools.exec_command'
  const callAt = script.indexOf(marker)
  if (callAt < 0 || script.indexOf(marker, callAt + marker.length) >= 0) return null
  let cursor = callAt + marker.length
  while (/\s/.test(script[cursor] ?? '')) cursor += 1
  if (script[cursor] !== '(') return null
  const callEnd = matchingCallEnd(script, cursor)
  if (callEnd === null) return null

  const prefix = script.slice(0, callAt).trim()
  const suffix = script.slice(callEnd + 1).trim()
  const assignment = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s*$/.exec(prefix)
  const unassigned = /^await\s*$/.test(prefix)
  if (!assignment && !unassigned) return null

  let presentation: UnifiedResultPresentation = 'discarded'
  if (assignment) {
    const variable = escapeRegExp(assignment[1])
    const direct = new RegExp(`^;?\\s*text\\(\\s*${variable}\\.output\\s*\\)\\s*;?$`)
    const serialized = new RegExp(
      `^;?\\s*text\\(\\s*JSON\\.stringify\\(\\s*${variable}\\s*\\)\\s*\\)\\s*;?$`,
    )
    if (direct.test(suffix)) presentation = 'direct-output'
    else if (serialized.test(suffix)) presentation = 'serialized-result'
    else return null
  } else if (!/^;?$/.test(suffix)) {
    return null
  }

  const argument = script.slice(cursor + 1, callEnd).trim()
  const parsed = parseExecCommandArgument(argument)
  return parsed ? { ...parsed, presentation } : null
}

/** Locate the closing parenthesis without executing or fully parsing generated
 * JavaScript. Backtick templates are deliberately rejected: `${...}` would
 * require a JavaScript expression parser before we could prove the call
 * boundary or the resulting command bytes. */
function matchingCallEnd(source: string, openAt: number): number | null {
  let depth = 1
  let quote: '"' | "'" | null = null
  for (let i = openAt + 1; i < source.length; i += 1) {
    const char = source[i]
    if (quote) {
      if (char === '\\') {
        i += 1
        continue
      }
      if (char === quote) quote = null
      continue
    }
    if (char === '`') return null
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '/' && source[i + 1] === '/') {
      const newline = source.indexOf('\n', i + 2)
      if (newline < 0) return null
      i = newline
      continue
    }
    if (char === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2)
      if (close < 0) return null
      i = close + 1
      continue
    }
    if (char === '(') depth += 1
    if (char === ')') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return null
}

function parseExecCommandArgument(argument: string): Omit<TransparentExecInvocation, 'presentation'> | null {
  const direct = decodeDoubleQuotedLiteral(argument)
  if (direct !== null) {
    return {
      command: direct,
      workdir: null,
      yieldTimeMs: null,
      maxOutputTokens: null,
    }
  }
  if (!argument.startsWith('{') || !argument.endsWith('}')) return null
  const fields = simpleObjectFields(argument.slice(1, -1))
  if (!fields) return null
  const command = decodeDoubleQuotedLiteral(fields.get('cmd') ?? fields.get('command') ?? '')
  if (command === null || !/\S/.test(command)) return null
  const workdirValue = fields.get('workdir')
  const workdir = workdirValue === undefined
    ? null
    : decodeDoubleQuotedLiteral(workdirValue)
  if (workdirValue !== undefined && workdir === null) return null
  return {
    command,
    workdir,
    yieldTimeMs: finiteNumber(fields.get('yield_time_ms') ?? fields.get('yield_time-ms')),
    maxOutputTokens: finiteNumber(fields.get('max_output_tokens') ?? fields.get('max-output-tokens')),
  }
}

function simpleObjectFields(body: string): Map<string, string> | null {
  const fields = new Map<string, string>()
  const segments = splitSimpleTopLevel(body, ',')
  if (!segments) return null
  for (const segment of segments) {
    if (!segment.trim()) continue
    const pair = splitSimpleTopLevel(segment, ':')
    if (!pair || pair.length !== 2) return null
    const rawKey = pair[0].trim()
    const quotedKey = decodeDoubleQuotedLiteral(rawKey)
    const key = quotedKey ?? (/^[A-Za-z_$][\w$-]*$/.test(rawKey) ? rawKey : null)
    if (!key || fields.has(key)) return null
    fields.set(key, pair[1].trim())
  }
  return fields
}

function splitSimpleTopLevel(source: string, separator: ',' | ':'): string[] | null {
  const out: string[] = []
  let start = 0
  let quote: '"' | "'" | null = null
  let round = 0
  let square = 0
  let curly = 0
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]
    if (quote) {
      if (char === '\\') i += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === '`') return null
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '(') round += 1
    else if (char === ')') round -= 1
    else if (char === '[') square += 1
    else if (char === ']') square -= 1
    else if (char === '{') curly += 1
    else if (char === '}') curly -= 1
    if (round < 0 || square < 0 || curly < 0) return null
    if (char === separator && round === 0 && square === 0 && curly === 0) {
      out.push(source.slice(start, i))
      start = i + 1
    }
  }
  if (quote || round !== 0 || square !== 0 || curly !== 0) return null
  out.push(source.slice(start))
  return out
}

function decodeDoubleQuotedLiteral(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) return null
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return typeof parsed === 'string' ? parsed : null
  } catch {
    return null
  }
}

function finiteNumber(value: string | undefined): number | null {
  if (value === undefined) return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Modern unified-exec wrapper, PLAIN-COMMAND case: extract up to six
 *  tools.exec_command("…") arguments from one bounded renderer page
 *  (first-match-only hid Promise.all fan-outs — #524 history 078b0e54).
 *  Declines when none decode. */
export function fromCodexExecScript(
  block: ToolUseBlock,
  opts: {
    streaming?: boolean
    live?: boolean
    result?: ToolResultBlock | null
  } = {},
): CommandRenderModel | null {
  const exact = fromCodexCommandOperation({
    toolUse: block,
    result: opts.result ?? null,
    streaming: opts.streaming,
    live: opts.live,
  })
  if (exact) return exact.model
  const script = applyPatchScriptText(block.input)
  if (!script) return null
  // WHY precedence and command extraction share the same bounded page: this
  // adapter runs repeatedly as a live generated script grows. Searching the
  // complete source for apply_patch and then scanning it again for an exact
  // command count made every streaming frame proportional to an untrusted,
  // mostly hidden tail. The code-edit adapter gets first refusal in dispatch;
  // this command adapter owns only what its renderer-sized page can prove.
  // Anything beyond that page remains in the complete transcript and is
  // disclosed below as uninspected rather than synchronously decoded.
  // A direct slice is intentional here rather than boundedTextPage: the
  // line-aware pager uses String#indexOf to find newlines, which may inspect a
  // newline-free source beyond its returned character window. Generated JS is
  // commonly one enormous line, so only an explicit end index gives this hot
  // admission path a hard O(TEXT_PAGE_MAX_CHARS) ceiling.
  const inspectedScript = script.slice(0, TEXT_PAGE_MAX_CHARS)
  const hasUninspectedTail = inspectedScript.length < script.length
  // WHY an apply-patch CALL, not sentinel text, owns precedence: examples and
  // tests legitimately store patch literals before running real commands. A
  // sentinel-only script has no edit side effect, so rejecting it here hid
  // proven tools.exec_command calls behind generic JSON. Actual apply_patch
  // invocations still stay with codeEdit, even if the generated cell also
  // contains commands, because that card owns the cell's mutation evidence.
  if (/\btools\.apply_patch\s*\(/.test(inspectedScript)) return null
  const commands: string[] = []
  let omittedCommands = 0
  const re = /tools\.exec_command\(\s*(?:\{[^}]*?cmd\s*:\s*)?"((?:[^"\\]|\\.)*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(inspectedScript)) !== null) {
    try {
      const command = JSON.parse(`"${m[1]}"`) as string
      if (commands.length < 6) commands.push(command)
      else omittedCommands += 1
    } catch {
      /* torn escape mid-stream — skip this one */
    }
  }
  if (commands.length === 0) return null
  const evidence = commandResultEvidence(opts.result ?? null, 'discarded')
  const lifecycle = commandLifecycle({
    result: opts.result ?? null,
    evidence,
    streaming: opts.streaming,
  })
  const omission = execScriptOmissionMessage(omittedCommands, hasUninspectedTail)
  return {
    label: 'exec',
    command: [
      ...commands.map(truncateCommand),
      ...(omission ? [omission] : []),
    ].join('\n'),
    status: lifecycle.status,
    exitCode: evidence.exitCode,
    errorSummary: lifecycle.errorSummary,
  }
}

function execScriptOmissionMessage(
  omittedCommands: number,
  hasUninspectedTail: boolean,
): string | null {
  if (!hasUninspectedTail) {
    return omittedCommands > 0
      ? `… ${omittedCommands} additional exec_command ${omittedCommands === 1 ? 'call' : 'calls'} omitted from preview`
      : null
  }

  // WHY a truncated page never prints an exact omitted-call count: we know
  // only how many calls occurred after the six-card cap inside the admitted
  // page. Counting the hidden tail would defeat the bound, while pretending
  // it contains another call would manufacture evidence. Distinguish the
  // proven lower bound from the honest “may” case when all six visible slots
  // were used but no seventh call fit in the page.
  if (omittedCommands > 0) {
    return `… at least ${omittedCommands} additional exec_command ${omittedCommands === 1 ? 'call' : 'calls'} omitted from preview; hidden script tail not inspected`
  }
  if (omittedCommands === 0) {
    return '… hidden script tail not inspected; additional exec_command calls may be omitted from preview'
  }
  return null
}

function commandResultEvidence(
  result: ToolResultBlock | null,
  transport: 'native' | UnifiedResultPresentation,
): CommandResultEvidence {
  if (!result) return { exitCode: null, failed: false, owned: false }
  const codex = asRecord(asRecord(result)?.codex)
  const nativeExit = numericField(codex, 'exitCode', 'exit_code')
  const materialized = toolResultContentText(result.content)

  if (transport === 'native') {
    const envelope = parseCodexTransportEnvelope(materialized)
    const output = envelope?.output ?? materialized
    return {
      output,
      exitCode: nativeExit,
      failed: result.is_error === true || envelope?.status === 'failed' ||
        (nativeExit !== null && nativeExit !== 0),
      owned: true,
    }
  }

  const envelope = parseCodexTransportEnvelope(materialized)
  if (!envelope) {
    return {
      exitCode: nativeExit,
      failed: result.is_error === true || (nativeExit !== null && nativeExit !== 0),
      owned: false,
    }
  }
  if (transport === 'discarded') {
    return {
      exitCode: nativeExit,
      failed: result.is_error === true || envelope.status === 'failed',
      owned: false,
    }
  }
  if (transport === 'direct-output') {
    return {
      output: envelope.output,
      exitCode: nativeExit,
      failed: result.is_error === true || envelope.status === 'failed' ||
        (nativeExit !== null && nativeExit !== 0),
      owned: true,
    }
  }

  // WHY serialized results have a hard parse ceiling: JSON.parse must
  // materialize a second copy of every escaped output byte. Commands can emit
  // attacker-sized text even when the feed itself pages it safely. Above this
  // ceiling we retain the original paired result row instead of risking a
  // renderer allocation spike or pretending we consumed evidence we skipped.
  if (envelope.output.length > SERIALIZED_EXEC_RESULT_MAX_CHARS) {
    return {
      exitCode: nativeExit,
      failed: result.is_error === true || envelope.status === 'failed',
      owned: false,
    }
  }
  let serialized: Record<string, unknown> | null = null
  try {
    serialized = asRecord(JSON.parse(envelope.output))
  } catch {
    serialized = null
  }
  const output = typeof serialized?.output === 'string' ? serialized.output : null
  if (output === null) {
    return {
      exitCode: nativeExit,
      failed: result.is_error === true || envelope.status === 'failed',
      owned: false,
    }
  }
  const exitCode = numericField(serialized, 'exit_code', 'exitCode') ?? nativeExit
  return {
    output,
    exitCode,
    failed: result.is_error === true || envelope.status === 'failed' ||
      (exitCode !== null && exitCode !== 0),
    owned: true,
  }
}

function commandLifecycle(opts: {
  streaming?: boolean
  result: ToolResultBlock | null
  evidence: CommandResultEvidence
}): Pick<CommandRenderModel, 'status' | 'errorSummary'> {
  const { result, evidence } = opts

  // WHY a result-less durable invocation is "running", never "success": the
  // same committed shape represents both an in-flight command and a command
  // interrupted before Codex persisted its result. There is no evidence to
  // distinguish those states at this seam, but both disprove success. Live
  // context still matters for the streaming prefix; terminal success/failure
  // is granted only by an actual correlated result.
  const status: CommandRenderModel['status'] = evidence.failed
    ? 'failure'
    : result
      ? 'success'
      : opts.streaming
        ? 'streaming'
        : 'running'
  if (!evidence.failed) return { status, errorSummary: undefined }

  const output = evidence.output ?? ''
  const newline = output.indexOf('\n')
  const firstLine = (newline === -1 ? output : output.slice(0, newline)).slice(0, 200)
  return {
    status,
    errorSummary: firstLine || 'command failed',
  }
}

function numericField(
  record: Record<string, unknown> | null,
  ...keys: string[]
): number | null {
  for (const key of keys) {
    const value = record?.[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return null
}

function applyPatchScriptText(input: unknown): string {
  if (typeof input === 'string') return input
  const rec = asRecord(input)
  for (const key of ['raw', 'arguments', 'cmd', 'input'] as const) {
    if (typeof rec?.[key] === 'string') return rec[key] as string
  }
  return ''
}

/** Strip Codex's unified-exec transport envelope from RESULT text (#524
 *  history 661253a8: "Script completed / Wall time / Output:" boilerplate
 *  consumed the whole preview). Failure state is preserved by the caller
 *  via is_error/exit; wall time is dropped as decoration. */
export function stripCodexTransportEnvelope(text: string): string {
  return parseCodexTransportEnvelope(text)?.output ?? text
}

function parseCodexTransportEnvelope(
  text: string,
): { status: 'completed' | 'failed' | 'running'; output: string } | null {
  const takeLine = (start: number): { line: string; next: number } => {
    const newline = text.indexOf('\n', start)
    return newline === -1
      ? { line: text.slice(start), next: text.length }
      : { line: text.slice(start, newline), next: newline + 1 }
  }
  const first = takeLine(0)
  const statusMatch = /^Script (completed|failed|running)(?:\b.*)?$/.exec(first.line)
  if (!statusMatch) return null
  let cursor = first.next
  let current = takeLine(cursor)
  if (/^Wall time(?::|\b)/.test(current.line)) {
    cursor = current.next
    current = takeLine(cursor)
  }
  // `Output:` is the structural proof that the preceding lines are transport
  // chrome. A legitimate program can print "Script completed" itself; without
  // this delimiter, retain the complete output verbatim.
  if (current.line !== 'Output:') return null
  cursor = current.next
  if (cursor < text.length) {
    current = takeLine(cursor)
    if (/^\s*$/.test(current.line)) cursor = current.next
  }
  return {
    status: statusMatch[1] as 'completed' | 'failed' | 'running',
    output: text.slice(cursor),
  }
}
