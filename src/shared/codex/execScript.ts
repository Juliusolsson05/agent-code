// The grammar of Codex's code-mode `exec` tool, as far as we read it without
// executing anything.
//
// WHY this exists: modern Codex does not call `exec_command` directly. It
// emits `custom_tool_call(name="exec")` whose `input` is a JavaScript program,
// and the program calls `tools.exec_command({cmd: "…"})`, `tools.apply_patch(…)`,
// MCP tools, and so on. In the owner's corpus (2,457 rollouts) there are
// 98,350 such scripts. 82,604 of them make exactly one `tools.*` call; the rest
// make several or none. The arguments are JavaScript object literals, mostly
// with unquoted keys (73,789 of 87,184 `exec_command` arguments are not JSON),
// so `JSON.parse` alone cannot read them.
//
// WHY shared, not renderer-private: the renderer's command adapter
// (`src/providers/codex/renderer/adapters/command.ts`) grew this grammar
// first, and the main-process transcript reader (#1362) needs the same
// answer to "which command did this script run". Two copies of a
// hand-written JavaScript tokenizer would drift. Only the pure grammar
// moved; presentation rules (which scripts may absorb their result row) stay
// in the renderer adapter, because they are about rendering, not about what
// the agent did.
//
// WHY no JavaScript parser: we never evaluate generated code. Anything whose
// boundary or bytes cannot be proven lexically (backtick templates, which
// may interpolate, and computed arguments) is reported as unreadable rather
// than guessed. Callers decide what an unreadable call means for them.

/** One decoded `tools.exec_command(...)` argument. */
export type CodexExecCommandArgument = {
  command: string
  workdir: string | null
  yieldTimeMs: number | null
  maxOutputTokens: number | null
}

/** One `tools.<name>(…)` call found in an `exec` script. `argument` is the raw
 *  argument source when the call's closing parenthesis could be proven, else
 *  null (a backtick template, an unterminated string, a truncated script). */
export type CodexExecScriptCall = {
  tool: string
  argument: string | null
}

/** Every `tools.<name>(` call in source order. Scanning resumes after each
 *  proven call, and after the opening parenthesis of an unproven one, so a
 *  string that merely contains the text `tools.x(` inside a proven argument
 *  is not double-counted. */
export function codexExecScriptCalls(script: string): CodexExecScriptCall[] {
  const calls: CodexExecScriptCall[] = []
  const pattern = /\btools\.([A-Za-z_$][\w$]*)\s*\(/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(script)) !== null) {
    const openAt = match.index + match[0].length - 1
    const closeAt = matchingCallEnd(script, openAt)
    calls.push({ tool: match[1], argument: closeAt === null ? null : script.slice(openAt + 1, closeAt).trim() })
    if (closeAt !== null) pattern.lastIndex = closeAt + 1
  }
  return calls
}

/** Locate the closing parenthesis without executing or fully parsing generated
 * JavaScript. Backtick templates are deliberately rejected: `${...}` would
 * require a JavaScript expression parser before we could prove the call
 * boundary or the resulting command bytes. */
export function matchingCallEnd(source: string, openAt: number): number | null {
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

/** Decode a `tools.exec_command` argument: a double-quoted string, or an
 *  object literal whose `cmd`/`command` (and optional `workdir`) are
 *  double-quoted strings. Anything computed is null. */
export function parseExecCommandArgument(argument: string): CodexExecCommandArgument | null {
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

export function splitSimpleTopLevel(source: string, separator: ',' | ':'): string[] | null {
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

export function decodeDoubleQuotedLiteral(value: string): string | null {
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
