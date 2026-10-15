import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'

import {
  bounded,
  DISCLOSURE_MAX,
  forDisclosure,
  isUserDecline,
  oneLine,
  singleText,
  type McpCallModel,
} from '@providers/shared/renderer/protocols/mcp-call/model'

// Claude Code's built-in HOUSEKEEPING tools as one line (#1522), in the same
// language as the MCP line (#1519): `◆ TaskStop  byk8lrbq9  ✓`.
//
// WHY a per-tool table instead of "absorb any short result": the line may
// only swallow a result it fully understands. Each entry names the one
// result shape that is an acknowledgement (recorded in
// testing/fixtures/claude-housekeeping/samples.json); anything else, such as a
// new wording, a payload or a multi-part result, keeps the shared result row,
// so a Claude Code release that changes these strings degrades to the old,
// complete rendering instead of hiding text.
//
// WHY these three: in the owner's last 80 transcripts (2026-10-15) they were
// the built-in tools that still fell through to the generic row (name +
// "1 param" + result) with an acknowledgement for a result. Skill and
// ScheduleWakeup are NOT here: the task-activity card (adapters/tasks.ts)
// already owns them and runs first in dispatch. Bash, Read, Write, Edit,
// ToolSearch, WebFetch/Search, Agent and AskUserQuestion have cards too;
// `exec`/`js` print real output and are not acknowledgements.

type Entry = {
  /** The call's one-line subject. */
  subject: (input: Record<string, unknown>) => string | null
  /** True when the (single, string) result text is this tool's acknowledgement. */
  ack: (text: string) => boolean
}

const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null)

const HOUSEKEEPING: Record<string, Entry> = {
  Monitor: {
    subject: (input) => str(input.description) ?? str(input.command),
    ack: (text) => /^Monitor started \(task /.test(text),
  },
  SendUserFile: {
    subject: (input) => str(input.caption) ?? (Array.isArray(input.files) ? input.files.map((file) => String(file).split('/').pop()).join(', ') : null),
    // Two recorded forms (owner corpus 2026-10-15: 91 bare, 108 with paths):
    // the bare sentence, and the sentence followed by exactly one indented
    // `<path> → file_uuid: …` line per delivered file (review of #1523).
    ack: (text) => {
      const [head, ...paths] = text.trimEnd().split('\n')
      const count = /^(\d+) files? delivered to user\.?$/.exec(head ?? '')
      return Boolean(count) && (paths.length === 0 || (paths.length === Number(count![1]) && paths.every((line) => /^ {2}\S/.test(line))))
    },
  },
  TaskStop: {
    subject: (input) => str(input.task_id),
    // Its success is a JSON envelope; only a well-formed "Successfully
    // stopped" one is the acknowledgement.
    ack: (text) => {
      try {
        const value = JSON.parse(text) as { message?: unknown }
        return typeof value.message === 'string' && value.message.startsWith('Successfully stopped task')
      } catch {
        return false
      }
    },
  },
}

export function isClaudeHousekeepingTool(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(HOUSEKEEPING, name)
}

export function fromClaudeHousekeepingLine(
  toolUse: ToolUseBlock,
  result: ToolResultBlock | null,
  options: { live?: boolean } = {},
): McpCallModel | null {
  const entry = Object.prototype.hasOwnProperty.call(HOUSEKEEPING, toolUse.name) ? HOUSEKEEPING[toolUse.name] : undefined
  if (!entry) return null
  const input = toolUse.input && typeof toolUse.input === 'object' && !Array.isArray(toolUse.input) ? (toolUse.input as Record<string, unknown>) : {}
  const subject = entry.subject(input)
  const base = {
    tool: toolUse.name,
    // Empty server: Claude Code's own tool, so the row shows no server chip
    // and no "server · tool" prefix (McpCallRow).
    server: '',
    ownServer: true,
    detail: subject ? oneLine(subject) : null,
    code: null,
    message: null,
    resultText: null,
  }
  if (!result || result.tool_use_id !== toolUse.id) {
    return { ...base, outcome: options.live ? 'pending' : 'no-result', absorbsResult: false }
  }
  const text = singleText(result.content)
  // Absorb only what the disclosure holds in full (see model.ts `fits`).
  const fits = text !== null && text.length <= DISCLOSURE_MAX
  if (result.is_error === true) {
    if (text !== null && isUserDecline(text)) {
      // The user declined or interrupted it: a choice, said the same way the
      // MCP line says it (review of #1523), not "✕ error".
      return { ...base, outcome: 'declined', message: bounded(text), resultText: forDisclosure(text), absorbsResult: fits }
    }
    // Claude Code wraps its own refusals in <tool_use_error>; the sentence
    // inside is what the user needs (recorded TaskStop on a finished task).
    const sentence = text?.replace(/^<tool_use_error>([\s\S]*)<\/tool_use_error>$/, '$1') ?? null
    return {
      ...base,
      outcome: 'error',
      message: sentence !== null ? bounded(sentence) : null,
      resultText: text !== null ? forDisclosure(text) : null,
      absorbsResult: fits,
    }
  }
  if (text !== null && entry.ack(text)) {
    return { ...base, outcome: 'ok', resultText: forDisclosure(text), absorbsResult: fits }
  }
  // Unrecognised: the line still names the call, the shared row keeps the result.
  return { ...base, outcome: 'content', absorbsResult: false }
}
