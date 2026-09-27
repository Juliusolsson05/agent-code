import { parse } from 'acorn'

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
// We never evaluate generated code. Finding the calls uses a parser
// (`codexExecScriptCalls`), but DECODING an argument stays lexical: anything
// whose bytes are not a plain literal (a template, which may interpolate, or a
// computed value) is reported as unreadable rather than guessed. Callers
// decide what an unreadable call means for them.

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

/** Every `tools.<name>(…)` call in source order.
 *
 * WHY a real parser first (#1368 verification b): the script is JavaScript,
 * and whether `/` starts a regex or divides depends on grammar a lexer cannot
 * see. `if (ready) /tools.apply_patch(x)/.test(s)` is a regex after `)`,
 * while `(x) / tools.apply_patch(y) / 2` is division. A heuristic lexer
 * misreads one of them either way, and inventing a patch or command that
 * never ran is the failure this reader exists to avoid. `acorn` is already a
 * runtime dependency (the renderer's embedded-operation adapter parses the
 * same scripts), and a parse reports exactly the calls that exist, including
 * calls inside template interpolations.
 *
 * A script that does not parse (malformed, or cut off) falls back to
 * `codexExecScriptCallsLexical`. Such a script never ran as written, so its
 * lexical reading is a best effort over text the model produced, not over
 * code that executed. */
export function codexExecScriptCalls(script: string): CodexExecScriptCall[] {
  let program: unknown
  try {
    program = parse(script, { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true })
  } catch {
    return codexExecScriptCallsLexical(script)
  }
  const found: Array<{ start: number; call: CodexExecScriptCall }> = []
  const stack: unknown[] = [program]
  while (stack.length > 0) {
    const node = stack.pop()
    if (Array.isArray(node)) {
      stack.push(...node)
      continue
    }
    if (!node || typeof node !== 'object') continue
    const record = node as Record<string, unknown>
    if (typeof record.type !== 'string') continue
    if (record.type === 'CallExpression') {
      const tool = toolsMemberName(record.callee)
      if (tool !== null) {
        const args = Array.isArray(record.arguments) ? record.arguments as Array<{ start: number; end: number }> : []
        const argument = args.length === 0 ? '' : script.slice(args[0]!.start, args[args.length - 1]!.end).trim()
        found.push({ start: record.start as number, call: { tool, argument } })
      }
    }
    for (const [key, value] of Object.entries(record)) {
      if (key !== 'type' && value && typeof value === 'object') stack.push(value)
    }
  }
  return found.sort((a, b) => a.start - b.start).map(entry => entry.call)
}

// `tools.name` or `tools["name"]`; any other callee (including a computed
// `tools[name]`, whose tool cannot be known) is not a recognised call.
function toolsMemberName(callee: unknown): string | null {
  const member = callee as { type?: string; object?: { type?: string; name?: string }; property?: { type?: string; name?: string; value?: unknown }; computed?: boolean } | null
  if (member?.type !== 'MemberExpression' || member.object?.type !== 'Identifier' || member.object.name !== 'tools') return null
  if (!member.computed && member.property?.type === 'Identifier') return member.property.name ?? null
  if (member.computed && member.property?.type === 'Literal' && typeof member.property.value === 'string') return member.property.value
  return null
}

/** The fallback for a script acorn cannot parse: every `tools.<name>(` call
 * in source order, found only in CODE by a lexical scan.
 *
 * WHY a lexical scan and not a regex over the whole script (#1368 review c):
 * a regex also matches `tools.exec_command(...)` inside a `//` comment or a
 * string, and the reader then reports a command that never ran, which is
 * worse than reporting none. The scan skips line and block comments, and
 * single-, double- and backtick-quoted literals.
 *
 * Regex literals are skipped too, told apart from division by the usual
 * lexer heuristic (a `/` where an expression may START is a regex). This is
 * not optional: generated shell-quoting helpers such as
 * `s.replace(/'/g, "'\\''")` are common, and without it the quote inside the
 * regex opened a phantom string that swallowed the real
 * `tools.exec_command(...)` after it. That was 70 recorded scripts in the
 * first version of this scan.
 *
 * Known limit, conservative (a real call is missed, never invented): a call
 * written inside a template's `${...}` interpolation is lexed past with the
 * template, not collected.
 *
 * After a proven call the scan resumes past its closing parenthesis, so text
 * inside the argument is never counted as a second call. After an unproven
 * one it resumes just past the opening parenthesis. */
export function codexExecScriptCallsLexical(script: string): CodexExecScriptCall[] {
  const calls: CodexExecScriptCall[] = []
  const callAt = /tools\.([A-Za-z_$][\w$]*)\s*\(/y
  for (let i = 0; i < script.length; i += 1) {
    const skipped = skipNonCode(script, i)
    if (skipped === 'unterminated') break
    if (skipped !== null) {
      i = skipped
      continue
    }
    // `tools` must start an identifier: `mytools.x(` is not a call to it.
    if (script[i] !== 't' || /[\w$.]/.test(script[i - 1] ?? '')) continue
    callAt.lastIndex = i
    const match = callAt.exec(script)
    if (!match) continue
    const openAt = i + match[0].length - 1
    const closeAt = matchingCallEnd(script, openAt)
    calls.push({ tool: match[1], argument: closeAt === null ? null : script.slice(openAt + 1, closeAt).trim() })
    i = closeAt ?? openAt
  }
  return calls
}

/**
 * If a comment, string, template or regex literal starts at `at`, the index
 * of its last character; `'unterminated'` if it never ends; otherwise null.
 *
 * A template's `${...}` is code, and may itself hold strings, regexes and
 * further templates: `` `'${s.replace(/'/g, `'"'"'`)}'` `` is the recorded
 * shell-quoting idiom. Skipping to the first backtick instead closed the
 * outer template early, and the rest of the script was read out of phase.
 */
function skipNonCode(source: string, at: number): number | 'unterminated' | null {
  const char = source[at]
  if (char === '/' && source[at + 1] === '/') {
    const newline = source.indexOf('\n', at + 2)
    return newline < 0 ? 'unterminated' : newline
  }
  if (char === '/' && source[at + 1] === '*') {
    const close = source.indexOf('*/', at + 2)
    return close < 0 ? 'unterminated' : close + 1
  }
  if (char === '"' || char === "'") {
    for (let i = at + 1; i < source.length; i += 1) {
      if (source[i] === '\\') i += 1
      else if (source[i] === char) return i
    }
    return 'unterminated'
  }
  if (char === '`') {
    for (let i = at + 1; i < source.length; i += 1) {
      if (source[i] === '\\') i += 1
      else if (source[i] === '`') return i
      else if (source[i] === '$' && source[i + 1] === '{') {
        const close = closingInterpolation(source, i + 2)
        if (close === 'unterminated') return close
        i = close
      }
    }
    return 'unterminated'
  }
  if (char === '/' && regexMayStart(source, at)) {
    // No closing slash on the line: it was division after all.
    return closingRegexSlash(source, at)
  }
  return null
}

// The `}` that ends a template interpolation whose code starts at `from`.
function closingInterpolation(source: string, from: number): number | 'unterminated' {
  let depth = 1
  for (let i = from; i < source.length; i += 1) {
    const skipped = skipNonCode(source, i)
    if (skipped === 'unterminated') return skipped
    if (skipped !== null) {
      i = skipped
      continue
    }
    if (source[i] === '{') depth += 1
    else if (source[i] === '}' && --depth === 0) return i
  }
  return 'unterminated'
}

// A `/` starts a regex literal where an expression may begin: after an
// operator or opening punctuation, after `return`-like keywords, or at the
// start. After an identifier, a number or `)` / `]` it is division.
function regexMayStart(source: string, slashAt: number): boolean {
  let j = slashAt - 1
  while (j >= 0 && /\s/.test(source[j]!)) j -= 1
  if (j < 0) return true
  const before = source[j]!
  if ('(,=:[!&|?{};+-*%<>~^'.includes(before)) return true
  const word = /[A-Za-z_$][\w$]*$/.exec(source.slice(Math.max(0, j - 10), j + 1))?.[0]
  return word === 'return' || word === 'typeof' || word === 'case' || word === 'in' || word === 'of'
}

function closingRegexSlash(source: string, openAt: number): number | null {
  let inClass = false
  for (let i = openAt + 1; i < source.length; i += 1) {
    const char = source[i]
    if (char === '\n') return null
    if (char === '\\') {
      i += 1
      continue
    }
    if (char === '[') inClass = true
    else if (char === ']') inClass = false
    else if (char === '/' && !inClass) return i
  }
  return null
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
