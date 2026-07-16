import type { ToolUseBlock } from '@shared/types/transcript'
import { asRecord } from '@shared/lib/asRecord'
import { boundedTextPage } from '@renderer/lib/text/boundedText'
import type { CommandRenderModel } from '@providers/shared/renderer/protocols/command/model'

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
  opts: { streaming?: boolean } = {},
): CommandRenderModel | null {
  const input = execCommandInput(block.input)
  if (!input) return null // unparseable/whitespace → caller falls back (preserved behavior)
  const meta: string[] = []
  if (input.yieldTimeMs !== null) meta.push(`yield ${input.yieldTimeMs}ms`)
  if (input.maxOutputTokens !== null) meta.push(`max ${input.maxOutputTokens} tok`)
  return {
    label: 'exec',
    command: input.command,
    cwd: input.workdir ?? undefined,
    status: opts.streaming ? 'streaming' : 'success',
    exitCode: null,
    conclusion: meta.length > 0 ? meta.join(' · ') : undefined,
  }
}

/** Modern unified-exec wrapper, PLAIN-COMMAND case: extract EVERY
 *  tools.exec_command("…") argument (first-match-only hid Promise.all
 *  fan-outs — #524 history 078b0e54). Declines when none decode. */
export function fromCodexExecScript(block: ToolUseBlock): CommandRenderModel | null {
  const script = applyPatchScriptText(block.input)
  if (!script || script.includes('*** Begin Patch')) return null // patches belong to codeEdit
  const commands: string[] = []
  const re = /tools\.exec_command\(\s*(?:\{[^}]*?cmd\s*:\s*)?"((?:[^"\\]|\\.)*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(script)) !== null && commands.length < 6) {
    try {
      commands.push(JSON.parse(`"${m[1]}"`) as string)
    } catch {
      /* torn escape mid-stream — skip this one */
    }
  }
  if (commands.length === 0) return null
  return {
    label: 'exec',
    command: commands.map(truncateCommand).join('\n'),
    status: 'success',
    exitCode: null,
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
  const lines = text.split('\n')
  let i = 0
  while (
    i < lines.length &&
    /^(Script (completed|failed|running).*|Wall time.*|Output:|\s*)$/.test(lines[i])
  ) {
    i += 1
  }
  return i > 0 && i < lines.length ? lines.slice(i).join('\n') : text
}
