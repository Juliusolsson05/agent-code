import { stripAnsi } from '@shared/git/gitParse'

export type CommandTestSummary = {
  passed: number | null
  failed: number | null
  skipped: number | null
}

export type CommandDiagnosticReference = {
  target: string
  path: string
  line: number
  column: number | null
  message: string
  severity: 'error' | 'warning' | 'info' | null
}

export type CommandOutputAnalysis = {
  structuredJson: unknown | null
  testSummary: CommandTestSummary | null
  diagnostics: CommandDiagnosticReference[]
  urls: string[]
}

const MAX_ANALYSIS_CHARS = 200_000
const MAX_DIAGNOSTICS = 8
const MAX_URLS = 8

type MutableTestSummary = {
  passed?: number
  failed?: number
  skipped?: number
}

function safeCount(raw: string): number | null {
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

function setCount(
  summary: MutableTestSummary,
  kind: keyof MutableTestSummary,
  raw: string,
): boolean {
  const value = safeCount(raw)
  // WHY duplicate categories invalidate the whole candidate: adding them is
  // tempting, but a line can contain both an aggregate and a nested runner's
  // count. A compact summary must be evidence, not arithmetic we guessed from
  // a format we only partly understood.
  if (value === null || summary[kind] !== undefined) return false
  summary[kind] = value
  return true
}

function finishTestSummary(summary: MutableTestSummary): CommandTestSummary | null {
  if (
    summary.passed === undefined &&
    summary.failed === undefined &&
    summary.skipped === undefined
  ) {
    return null
  }
  return {
    passed: summary.passed ?? null,
    failed: summary.failed ?? null,
    skipped: summary.skipped ?? null,
  }
}

function countsFromKnownSummaryLine(line: string): CommandTestSummary | null {
  const trimmed = line.trim()
  let body: string | null = null

  // Jest owns the `Tests:` prefix, while Vitest owns the visually similar
  // `Tests  12 passed (12)` row. Requiring the complete prefix avoids turning
  // ordinary command prose such as "all 12 tests passed" into a synthetic
  // runner result.
  if (/^Tests\s*:/i.test(trimmed)) {
    body = trimmed.replace(/^Tests\s*:\s*/i, '')
  } else if (/^Tests\s+/i.test(trimmed)) {
    body = trimmed.replace(/^Tests\s+/i, '')
  } else if (/^test result:\s*(?:ok|FAILED)\./i.test(trimmed)) {
    // Cargo calls skipped tests "ignored". Mapping that one documented term
    // to the UI's shared vocabulary is safe because the grammar is anchored
    // by Cargo's full `test result:` prefix.
    body = trimmed.replace(/^test result:\s*(?:ok|FAILED)\.\s*/i, '')
  } else {
    // Pytest's terminal summary is a complete line framed by `=` and/or ending
    // in a duration. Both boundaries matter: a loose `N passed` regex matched
    // package-manager prose and individual sub-suite messages in real logs.
    const framed = /^=+\s*(.*?)\s*=+$/.exec(trimmed)?.[1] ?? null
    const unframed = /^(.*?)\s+in\s+\d+(?:\.\d+)?s$/.exec(trimmed)?.[1] ?? null
    const candidate = (framed ?? unframed)?.replace(/\s+in\s+\d+(?:\.\d+)?s$/, '') ?? null
    const pytestItem = '\\d+\\s+(?:passed|failed|skipped|xfailed|xpassed|deselected|errors?|warnings?)'
    const pytestGrammar = new RegExp(`^${pytestItem}(?:(?:,\\s*|\\s+and\\s+)${pytestItem})*$`, 'i')
    body = candidate !== null && pytestGrammar.test(candidate) ? candidate : null
  }

  if (body === null) return null

  const summary: MutableTestSummary = {}
  const seen: Array<[string, string]> = []
  for (const match of body.matchAll(/(\d+)\s+(passed|failed|skipped|ignored)\b/gi)) {
    seen.push([match[1] ?? '', (match[2] ?? '').toLowerCase()])
  }
  for (const [raw, label] of seen) {
    const kind = label === 'ignored' ? 'skipped' : label as keyof MutableTestSummary
    if (!setCount(summary, kind, raw)) return null
  }
  return finishTestSummary(summary)
}

function nodeTestSummary(lines: string[]): CommandTestSummary | null {
  // Node's test runner reports TAP counters on separate lines. We only accept
  // a single `# tests N` footer in the entire payload; multiple footers mean
  // multiple/nested runners and presenting the last one as the command total
  // would be a confident lie.
  const testMarkers = lines
    .map((line, index) => ({ index, match: /^\s*#\s*tests\s+(\d+)\s*$/.exec(line) }))
    .filter(item => item.match !== null)
  if (testMarkers.length !== 1) return null

  const marker = testMarkers[0]
  const summary: MutableTestSummary = {}
  for (const line of lines.slice(marker.index + 1, marker.index + 12)) {
    const match = /^\s*#\s*(pass|fail|skipped)\s+(\d+)\s*$/.exec(line)
    if (!match) continue
    const kind = match[1] === 'pass' ? 'passed' : match[1] === 'fail' ? 'failed' : 'skipped'
    if (!setCount(summary, kind, match[2] ?? '')) return null
  }
  // `# tests` without both pass/fail counters is often a nested or truncated
  // TAP fragment. Waiting for the complete footer keeps streaming output from
  // flashing a premature success summary.
  if (summary.passed === undefined || summary.failed === undefined) return null
  return finishTestSummary(summary)
}

export function parseCommandTestSummary(text: string): CommandTestSummary | null {
  const lines = stripAnsi(text).replace(/\r\n?/g, '\n').split('\n')
  const summaries = lines
    .map(line => countsFromKnownSummaryLine(line))
    .filter((summary): summary is CommandTestSummary => summary !== null)
  // Multiple complete summaries usually mean a workspace script invoked
  // several runners (Cargo emits one footer per target). None of those rows is
  // the aggregate command result, so raw output is more honest than picking or
  // summing them.
  if (summaries.length === 1) return summaries[0]
  if (summaries.length > 1) return null
  return nodeTestSummary(lines)
}

function parseSeverity(message: string): CommandDiagnosticReference['severity'] {
  if (/^(?:fatal\s+)?error\b/i.test(message)) return 'error'
  if (/^warn(?:ing)?\b/i.test(message)) return 'warning'
  if (/^(?:info|note)\b/i.test(message)) return 'info'
  return null
}

export function parseCommandDiagnostics(text: string): CommandDiagnosticReference[] {
  const results: CommandDiagnosticReference[] = []
  const seen = new Set<string>()

  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    // Covers compiler-owned forms such as:
    //   src/feed.tsx:12:4: error TS2322: ...
    //   --> src/main.rs:12:4
    // It intentionally excludes stack frames, parenthesized locations, and
    // prose containing a colon-number sequence. Those may still be useful in
    // the raw output, but they are not unambiguous diagnostics.
    const match = /^\s*(?:(?:-->|:::)\s*)?((?:\.{1,2}\/|\/)?(?:[^\s:()]+\/)*[^\s:()]+\.[A-Za-z0-9]{1,12}):(\d+)(?::(\d+))?(?:(?:\s+-\s+|:\s+|\s+)(\S[\s\S]*?))?\s*$/.exec(line)
    if (!match) continue

    const path = match[1] ?? ''
    const parsedLine = safeCount(match[2] ?? '')
    const parsedColumn = match[3] === undefined ? null : safeCount(match[3])
    // Line/column zero are not valid editor destinations. Unlike test counts,
    // the parser must not normalize them to one because that would navigate to
    // a location the command never reported.
    if (!path || parsedLine === null || parsedLine === 0 || parsedColumn === 0) continue

    const target = `${path}:${parsedLine}${parsedColumn === null ? '' : `:${parsedColumn}`}`
    const message = match[4] ?? ''
    const identity = `${target}\0${message}`
    if (seen.has(identity)) continue
    seen.add(identity)
    results.push({
      target,
      path,
      line: parsedLine,
      column: parsedColumn,
      message,
      severity: parseSeverity(message),
    })
    if (results.length === MAX_DIAGNOSTICS) break
  }
  return results
}

function trimUrlPunctuation(candidate: string): string {
  let value = candidate.replace(/[.,;:!?]+$/g, '')
  // A URL in prose is commonly wrapped in parentheses. Parentheses are also
  // legal inside URLs, so remove a trailing one only when it is unbalanced.
  while (value.endsWith(')')) {
    const opens = (value.match(/\(/g) ?? []).length
    const closes = (value.match(/\)/g) ?? []).length
    if (closes <= opens) break
    value = value.slice(0, -1)
  }
  return value
}

export function parseCommandUrls(text: string): string[] {
  const urls: string[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'\x1b]+/gi)) {
    const value = trimUrlPunctuation(match[0])
    try {
      const parsed = new URL(value)
      if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || seen.has(value)) continue
    } catch {
      continue
    }
    seen.add(value)
    urls.push(value)
    if (urls.length === MAX_URLS) break
  }
  return urls
}

function parseCompleteJson(text: string): unknown | null {
  const trimmed = text.trim()
  // A scalar that happens to be `1`, `true`, or a quoted line is valid JSON
  // but adds no structure beyond the raw terminal text. Restricting the
  // summary to objects/arrays keeps this enrichment useful and prevents an
  // ordinary command printing a number from acquiring a misleading card.
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    return null
  }
}

export function analyzeCommandOutput(rawText: string): CommandOutputAnalysis {
  // OutputWell applies the same 200K visible cap. Analyzing only what the user
  // can inspect keeps every regex bounded and avoids surfacing a link or test
  // count that exists solely in a truncated, invisible tail.
  const plain = stripAnsi(rawText.slice(0, MAX_ANALYSIS_CHARS))
  // A valid JSON value at the 200K boundary may be followed by another value
  // in the omitted tail. Only parse when we saw the complete command output;
  // otherwise "complete grammar" would describe our slice, not the payload.
  const structuredJson = rawText.length <= MAX_ANALYSIS_CHARS ? parseCompleteJson(plain) : null

  return {
    structuredJson,
    // JSON already has an exact typed presentation through StructuredOutput.
    // Re-scanning strings nested inside it for runner prose/URLs would create
    // duplicate, context-free summaries beside the structured fields.
    testSummary: structuredJson === null ? parseCommandTestSummary(plain) : null,
    diagnostics: structuredJson === null ? parseCommandDiagnostics(plain) : [],
    urls: structuredJson === null ? parseCommandUrls(plain) : [],
  }
}
