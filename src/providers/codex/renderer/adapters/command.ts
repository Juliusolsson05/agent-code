import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'
import { asRecord } from '@shared/lib/asRecord'
import {
  boundedTextPage,
  TEXT_PAGE_MAX_CHARS,
} from '@renderer/lib/text/boundedText'
import type { CommandRenderModel } from '@providers/shared/renderer/protocols/command/model'
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
  const input = execCommandInput(block.input)
  if (!input) return null // unparseable/whitespace → caller falls back (preserved behavior)
  const meta: string[] = []
  if (input.yieldTimeMs !== null) meta.push(`yield ${input.yieldTimeMs}ms`)
  if (input.maxOutputTokens !== null) meta.push(`max ${input.maxOutputTokens} tok`)
  const lifecycle = codexCommandLifecycle(opts)
  return {
    label: 'exec',
    command: input.command,
    cwd: input.workdir ?? undefined,
    status: lifecycle.status,
    exitCode: lifecycle.exitCode,
    errorSummary: lifecycle.errorSummary,
    conclusion: meta.length > 0 ? meta.join(' · ') : undefined,
  }
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
  const lifecycle = codexCommandLifecycle(opts)
  const omission = execScriptOmissionMessage(omittedCommands, hasUninspectedTail)
  return {
    label: 'exec',
    command: [
      ...commands.map(truncateCommand),
      ...(omission ? [omission] : []),
    ].join('\n'),
    status: lifecycle.status,
    exitCode: lifecycle.exitCode,
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

function codexCommandLifecycle(opts: {
  streaming?: boolean
  live?: boolean
  result?: ToolResultBlock | null
}): Pick<CommandRenderModel, 'status' | 'exitCode' | 'errorSummary'> {
  const result = opts.result ?? null
  const codex = asRecord(asRecord(result)?.codex)
  const exitCode = typeof codex?.exitCode === 'number' ? codex.exitCode : null
  const failed = result?.is_error === true || (exitCode !== null && exitCode !== 0)

  // WHY a result-less durable invocation is "running", never "success": the
  // same committed shape represents both an in-flight command and a command
  // interrupted before Codex persisted its result. There is no evidence to
  // distinguish those states at this seam, but both disprove success. Live
  // context still matters for the streaming prefix; terminal success/failure
  // is granted only by an actual correlated result.
  const status: CommandRenderModel['status'] = failed
    ? 'failure'
    : result
      ? 'success'
      : opts.streaming
        ? 'streaming'
        : 'running'
  if (!failed) return { status, exitCode, errorSummary: undefined }

  const output = result
    ? stripCodexTransportEnvelope(toolResultContentText(result.content))
    : ''
  const newline = output.indexOf('\n')
  const firstLine = (newline === -1 ? output : output.slice(0, newline)).slice(0, 200)
  return {
    status,
    exitCode,
    errorSummary: firstLine || 'command failed',
  }
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
  const takeLine = (start: number): { line: string; next: number } => {
    const newline = text.indexOf('\n', start)
    return newline === -1
      ? { line: text.slice(start), next: text.length }
      : { line: text.slice(start, newline), next: newline + 1 }
  }
  const first = takeLine(0)
  if (!/^Script (completed|failed|running)(?:\b.*)?$/.test(first.line)) return text
  let cursor = first.next
  let current = takeLine(cursor)
  if (/^Wall time(?::|\b)/.test(current.line)) {
    cursor = current.next
    current = takeLine(cursor)
  }
  // `Output:` is the structural proof that the preceding lines are transport
  // chrome. A legitimate program can print "Script completed" itself; without
  // this delimiter, retain the complete output verbatim.
  if (current.line !== 'Output:') return text
  cursor = current.next
  if (cursor < text.length) {
    current = takeLine(cursor)
    if (/^\s*$/.test(current.line)) cursor = current.next
  }
  return text.slice(cursor)
}
