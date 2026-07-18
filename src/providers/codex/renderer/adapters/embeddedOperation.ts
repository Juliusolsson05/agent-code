import { asRecord } from '@shared/lib/asRecord'
import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'

const MAX_SCRIPT_CHARS = 256 * 1024
const MAX_LITERAL_DEPTH = 8
const MAX_LITERAL_FIELDS = 64

export type CodexEmbeddedOperationModel = {
  operationId: string
  toolName: string
  action: string
  subject: string | null
  input: Record<string, unknown>
  exactScript: string
  resultPresent: boolean
  failed: boolean
}

export type CodexWaitOperationModel = {
  operationId: string
  cellId: string
  yieldTimeMs: number | null
  maxTokens: number | null
  resultPresent: boolean
  failed: boolean
}

const ACTIONS: Record<string, string> = {
  workflow_run: 'Run workflow',
  workflow_resume: 'Resume workflow',
  workflow_run_status: 'Check workflow status',
  workflow_run_events: 'Read workflow events',
  workflow_run_cancel: 'Cancel workflow',
  workflow_result_read: 'Read workflow result',
  orchestration_create_agent: 'Create agent',
  orchestration_send_prompt: 'Send agent prompt',
  orchestration_list_agents: 'List agents',
  orchestration_read_agent: 'Read agent',
  orchestration_read_run_outputs: 'Read run outputs',
  orchestration_wait_agents: 'Wait for agents',
  orchestration_close_agent: 'Close agent',
  orchestration_close_run: 'Close run',
}

/**
 * Recover the meaningful Agent Code operation from Codex's unified `exec`
 * transport without evaluating general JavaScript.
 *
 * WHY identity and result ownership are deliberately separate: a script may
 * call one proven MCP tool and then project, filter, or annotate its result.
 * The literal call is still the honest user-visible operation, but absorbing
 * the outer result would hide bytes whose provenance the adapter has not
 * proven. Dispatch therefore specializes the invocation and labels the paired
 * result while leaving that result independently visible.
 */
export function fromCodexEmbeddedOperation(input: {
  toolUse: ToolUseBlock
  result: ToolResultBlock | null
}): CodexEmbeddedOperationModel | null {
  if (input.toolUse.name !== 'exec') return null
  const raw = asRecord(input.toolUse.input)?.raw
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_SCRIPT_CHARS) return null

  const call = directAgentCodeCall(raw)
  if (!call) return null
  const action = ACTIONS[call.operation] ?? humanizeOperation(call.operation)
  return {
    operationId: input.toolUse.id,
    toolName: `mcp__agent_code__${call.operation}`,
    action,
    subject: operationSubject(call.input),
    input: call.input,
    exactScript: raw,
    resultPresent: input.result !== null,
    failed: input.result?.is_error === true,
  }
}

export function fromCodexWaitOperation(input: {
  toolUse: ToolUseBlock
  result: ToolResultBlock | null
}): CodexWaitOperationModel | null {
  if (input.toolUse.name !== 'wait') return null
  const value = asRecord(input.toolUse.input)
  if (!value || typeof value.cell_id !== 'string' || !/\S/.test(value.cell_id)) return null
  if (!onlyKeys(value, ['cell_id', 'yield_time_ms', 'max_tokens', 'terminate'])) return null
  if (value.terminate !== undefined && typeof value.terminate !== 'boolean') return null
  const yieldTimeMs = optionalFiniteNumber(value['yield_time_ms'])
  const maxTokens = optionalFiniteNumber(value.max_tokens)
  if (value['yield_time_ms'] !== undefined && yieldTimeMs === null) return null
  if (value.max_tokens !== undefined && maxTokens === null) return null
  return {
    operationId: input.toolUse.id,
    cellId: value.cell_id,
    yieldTimeMs,
    maxTokens,
    resultPresent: input.result !== null,
    failed: input.result?.is_error === true,
  }
}

function directAgentCodeCall(source: string): {
  operation: string
  input: Record<string, unknown>
} | null {
  const marker = 'tools.mcp__agent_code__'
  const starts = codeTokenOffsets(source, marker)
  if (starts.length !== 1) return null
  const callAt = starts[0]
  const nameAt = callAt + marker.length
  const nameMatch = /^[A-Za-z][A-Za-z0-9_]*\b/.exec(source.slice(nameAt))
  if (!nameMatch) return null
  let cursor = nameAt + nameMatch[0].length
  while (/\s/.test(source[cursor] ?? '')) cursor += 1
  if (source[cursor] !== '(') return null
  const close = matchingCallEnd(source, cursor)
  if (close === null) return null

  // WHY require the call to be the top-level awaited operation: examples,
  // dead branches, callbacks, and nested helper calls can contain the same
  // literal token without proving that it ran. The suffix may transform the
  // result because we do not absorb it; the prefix must prove execution.
  const prefix = source.slice(0, callAt).trim()
  if (!/^(?:(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*)?await\s*$/.test(prefix)) {
    return null
  }

  const literal = new LiteralParser(source.slice(cursor + 1, close))
  const value = literal.parse()
  const record = asRecord(value)
  if (!record) return null
  return { operation: nameMatch[0], input: record }
}

/** Return marker offsets that occur in executable code, not strings/comments. */
function codeTokenOffsets(source: string, marker: string): number[] {
  const offsets: number[] = []
  let quote: '"' | "'" | null = null
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (quote) {
      if (char === '\\') index += 1
      else if (char === quote) quote = null
      continue
    }
    // Templates can execute arbitrary interpolation. Rejecting the marker as
    // code while inside one is safer than attempting a partial JS parser.
    if (char === '`') {
      const end = source.indexOf('`', index + 1)
      if (end < 0) return []
      index = end
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '/' && source[index + 1] === '/') {
      const end = source.indexOf('\n', index + 2)
      if (end < 0) break
      index = end
      continue
    }
    if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2)
      if (end < 0) return []
      index = end + 1
      continue
    }
    if (source.startsWith(marker, index)) {
      offsets.push(index)
      index += marker.length - 1
    }
  }
  return offsets
}

function matchingCallEnd(source: string, openAt: number): number | null {
  let depth = 1
  let quote: '"' | "'" | null = null
  for (let index = openAt + 1; index < source.length; index += 1) {
    const char = source[index]
    if (quote) {
      if (char === '\\') index += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === '`') return null
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '/' && source[index + 1] === '/') {
      const end = source.indexOf('\n', index + 2)
      if (end < 0) return null
      index = end
      continue
    }
    if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2)
      if (end < 0) return null
      index = end + 1
      continue
    }
    if (char === '(') depth += 1
    else if (char === ')' && --depth === 0) return index
  }
  return null
}

class LiteralParser {
  private cursor = 0
  private fields = 0

  constructor(private readonly source: string) {}

  parse(): unknown | null {
    const value = this.value(0)
    this.space()
    return value === INVALID || this.cursor !== this.source.length ? null : value
  }

  private value(depth: number): unknown | typeof INVALID {
    if (depth > MAX_LITERAL_DEPTH) return INVALID
    this.space()
    const char = this.source[this.cursor]
    if (char === '"') return this.string()
    if (char === '{') return this.object(depth + 1)
    if (char === '[') return this.array(depth + 1)
    const keyword = /^(true|false|null)\b/.exec(this.source.slice(this.cursor))
    if (keyword) {
      this.cursor += keyword[0].length
      return keyword[1] === 'true' ? true : keyword[1] === 'false' ? false : null
    }
    const numeric = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?\b/.exec(
      this.source.slice(this.cursor),
    )
    if (!numeric) return INVALID
    this.cursor += numeric[0].length
    const value = Number(numeric[0])
    return Number.isFinite(value) ? value : INVALID
  }

  private object(depth: number): Record<string, unknown> | typeof INVALID {
    this.cursor += 1
    // WHY null-prototype plus the explicit __proto__ refusal: assigning a
    // generated `__proto__` key to `{}` invokes JavaScript's legacy prototype
    // setter instead of recording the literal field. That would let displayed
    // identity come from an inherited runId even though the parser claims to
    // have recovered a plain data object. We do not execute the input, and we
    // must not accidentally emulate its ambient object-prototype semantics.
    const result = Object.create(null) as Record<string, unknown>
    this.space()
    if (this.source[this.cursor] === '}') {
      this.cursor += 1
      return result
    }
    while (this.cursor < this.source.length) {
      this.space()
      const key = this.source[this.cursor] === '"'
        ? this.string()
        : this.identifier()
      if (
        typeof key !== 'string' ||
        key === '__proto__' ||
        Object.prototype.hasOwnProperty.call(result, key)
      ) return INVALID
      this.fields += 1
      if (this.fields > MAX_LITERAL_FIELDS) return INVALID
      this.space()
      if (this.source[this.cursor] !== ':') return INVALID
      this.cursor += 1
      const value = this.value(depth)
      if (value === INVALID) return INVALID
      result[key] = value
      this.space()
      const separator = this.source[this.cursor]
      this.cursor += 1
      if (separator === '}') return result
      if (separator !== ',') return INVALID
    }
    return INVALID
  }

  private array(depth: number): unknown[] | typeof INVALID {
    this.cursor += 1
    const result: unknown[] = []
    this.space()
    if (this.source[this.cursor] === ']') {
      this.cursor += 1
      return result
    }
    while (result.length < MAX_LITERAL_FIELDS) {
      const value = this.value(depth)
      if (value === INVALID) return INVALID
      this.fields += 1
      if (this.fields > MAX_LITERAL_FIELDS) return INVALID
      result.push(value)
      this.space()
      const separator = this.source[this.cursor]
      this.cursor += 1
      if (separator === ']') return result
      if (separator !== ',') return INVALID
    }
    return INVALID
  }

  private string(): string | typeof INVALID {
    const start = this.cursor
    this.cursor += 1
    while (this.cursor < this.source.length) {
      const char = this.source[this.cursor]
      if (char === '\\') {
        this.cursor += 2
        continue
      }
      this.cursor += 1
      if (char !== '"') continue
      try {
        const parsed: unknown = JSON.parse(this.source.slice(start, this.cursor))
        return typeof parsed === 'string' ? parsed : INVALID
      } catch {
        return INVALID
      }
    }
    return INVALID
  }

  private identifier(): string | typeof INVALID {
    const match = /^[A-Za-z_$][\w$-]*/.exec(this.source.slice(this.cursor))
    if (!match) return INVALID
    this.cursor += match[0].length
    return match[0]
  }

  private space(): void {
    while (/\s/.test(this.source[this.cursor] ?? '')) this.cursor += 1
  }
}

const INVALID = Symbol('invalid-literal')

function operationSubject(input: Record<string, unknown>): string | null {
  for (const key of ['title', 'name', 'runId', 'sessionId', 'cwd']) {
    const value = input[key]
    if (typeof value === 'string' && /\S/.test(value)) return value.slice(0, 240)
  }
  return null
}

function humanizeOperation(operation: string): string {
  return operation
    .replace(/^(?:workflow|orchestration|ai_workspace)_/, '')
    .split('_')
    .filter(Boolean)
    .map(word => word[0]?.toUpperCase() + word.slice(1))
    .join(' ')
}

function onlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  const allowedSet = new Set(allowed)
  return Object.keys(value).every(key => allowedSet.has(key))
}

function optionalFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}
