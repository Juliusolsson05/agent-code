// Pure, provider-neutral recognition for output that is neither plain text nor
// one complete JSON document. Real tools frequently put useful provenance in
// front of a JSON value (`path:line:{...}`, `INFO {...}`, or JSONL). Treating
// the whole string as JSON loses that provenance; treating it as terminal text
// leaves a multi-thousand-character object unreadable.

const MAX_SCAN_CHARS = 768 * 1024
const MAX_SCAN_LINES = 160
const MAX_RECORDS = 40
const MAX_CONTEXT_LINES = 16
const MAX_CONTEXT_CHARS = 320
const MAX_PREFIX_CHARS = 4 * 1024
const MAX_JSON_CHARS = 512 * 1024
const MAX_JSON_START_ATTEMPTS = 16

export type StructuredJsonRecord = {
  key: string
  prefix: string
  path: string | null
  lineNumber: number | null
  jsonSource: string
  summary: string
  discriminatorLabel: string | null
  messagePreview: string | null
  isError: boolean
}

export type StructuredOutputModel = {
  records: StructuredJsonRecord[]
  contextLines: string[]
  scannedLineCount: number
  omittedRecordCount: number
  contextWasTruncated: boolean
  scanWasTruncated: boolean
}

type JsonSummary = {
  label: string
  isError: boolean
}

function summarizeJson(value: unknown): JsonSummary {
  if (Array.isArray(value)) {
    return {
      label: `${value.length.toLocaleString()} ${value.length === 1 ? 'item' : 'items'}`,
      isError: false,
    }
  }

  const record = value as Record<string, unknown>
  if (record.isError === true) return { label: 'isError: true', isError: true }
  if (record.ok === false) return { label: 'ok: false', isError: true }
  if (record.ok === true) return { label: 'ok: true', isError: false }

  // WHY stop at forty instead of Object.keys(record).length: recognition runs
  // before the user expands anything. A generated object with a million keys
  // must not force a million-element temporary allocation merely to label a
  // closed row. The exact object remains available when explicitly opened.
  let keyCount = 0
  for (const key in record) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue
    keyCount += 1
    if (keyCount >= 40) return { label: '40+ keys', isError: false }
  }
  return {
    label: `${keyCount} ${keyCount === 1 ? 'key' : 'keys'}`,
    isError: false,
  }
}

function boundedScalar(value: unknown, maxChars = 80): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxChars ||
    !/\S/.test(value)
  ) return null
  return value.replace(/\s+/g, ' ').trim()
}

function recordDiscriminator(value: unknown): {
  label: string | null
  messagePreview: string | null
} {
  if (Array.isArray(value)) return { label: null, messagePreview: null }
  const record = value as Record<string, unknown>
  const discriminator = boundedScalar(record.type) ??
    boundedScalar(record.kind) ??
    boundedScalar(record.event) ??
    boundedScalar(record.status) ??
    boundedScalar(record.action)
  const identity = boundedScalar(record.label) ??
    boundedScalar(record.name) ??
    boundedScalar(record.agentId) ??
    boundedScalar(record.id)
  const cursor = boundedScalar(record.cursor)
  const pieces = [identity, discriminator, cursor === null ? null : `cursor ${cursor}`]
    .filter((piece): piece is string => piece !== null)
  return {
    label: pieces.length > 0 ? pieces.join(' · ') : null,
    messagePreview: boundedScalar(record.message, 180),
  }
}

function sourceLocation(prefix: string): { path: string; lineNumber: number } | null {
  // `rg -n`, grep, compiler diagnostics, and many search tools use this exact
  // shape. The greedy path group deliberately keeps colons inside a filename;
  // the final decimal segment is the only part we claim as a line number.
  const match = /^(.+):(\d+):$/.exec(prefix)
  if (!match) return null
  const lineNumber = Number(match[2])
  if (!Number.isSafeInteger(lineNumber) || lineNumber < 1) return null
  return { path: match[1], lineNumber }
}

function isJsonBoundary(character: string | undefined): boolean {
  return character === undefined || /[\s:=|>\-]/.test(character)
}

function parseRecord(line: string, recordIndex: number): StructuredJsonRecord | null {
  const firstNonWhitespace = line.search(/\S/)
  if (firstNonWhitespace < 0) return null

  let attempts = 0
  for (let index = firstNonWhitespace; index < line.length; index += 1) {
    const character = line[index]
    if (character !== '{' && character !== '[') continue
    if (!isJsonBoundary(index === firstNonWhitespace ? undefined : line[index - 1])) continue
    attempts += 1
    if (attempts > MAX_JSON_START_ATTEMPTS) return null

    const prefix = line.slice(0, index).trimEnd()
    if (prefix.length > MAX_PREFIX_CHARS) return null

    const jsonSource = line.slice(index).trimEnd()
    if (jsonSource.length === 0 || jsonSource.length > MAX_JSON_CHARS) return null

    try {
      const value: unknown = JSON.parse(jsonSource)
      // JSON scalars embedded in prose are common (`exit: 1`, `value: null`)
      // and formatting them buys nothing while creating false positives. A
      // container is the evidence that a structured view is materially useful.
      if (typeof value !== 'object' || value === null) continue
      const location = sourceLocation(prefix)
      const summary = summarizeJson(value)
      const discriminator = recordDiscriminator(value)
      return {
        key: `${recordIndex}:${index}`,
        prefix,
        path: location?.path ?? null,
        lineNumber: location?.lineNumber ?? null,
        jsonSource,
        summary: summary.label,
        discriminatorLabel: discriminator.label,
        messagePreview: discriminator.messagePreview,
        isError: summary.isError,
      }
    } catch {
      // A brace in ordinary output is not evidence. Continue looking for a
      // later, boundary-delimited container on the same line; log prefixes can
      // themselves contain bracketed timestamps before the JSON payload.
    }
  }
  return null
}

/**
 * Recognize a bounded prefix of line-oriented structured output.
 *
 * This is intentionally independent of `rg`, shell syntax, and providers. The
 * grammar is the durable part: one complete JSON container, optionally preceded
 * by a provenance prefix. Whole-document JSON remains owned by tryExtractJson;
 * this recognizer fills the mixed-output / JSONL gap.
 */
export function parseStructuredOutput(source: string): StructuredOutputModel | null {
  if (source.length === 0) return null

  const scanEnd = Math.min(source.length, MAX_SCAN_CHARS)
  const records: StructuredJsonRecord[] = []
  const contextLines: string[] = []
  let omittedRecordCount = 0
  let contextWasTruncated = false
  let scannedLineCount = 0
  let cursor = 0

  // WHY use indexOf instead of split: a command can emit hundreds of thousands
  // of lines. Splitting allocates every substring before any display budget can
  // reject it; this iterator materializes at most MAX_SCAN_LINES bounded lines.
  while (cursor < scanEnd && scannedLineCount < MAX_SCAN_LINES) {
    const newline = source.indexOf('\n', cursor)
    const physicalEnd = newline < 0 ? source.length : newline
    if (physicalEnd > scanEnd) break

    const line = source.slice(cursor, physicalEnd).replace(/\r$/, '')
    const record = parseRecord(line, scannedLineCount)
    if (record) {
      if (records.length < MAX_RECORDS) records.push(record)
      else omittedRecordCount += 1
    } else if (line.trim().length > 0) {
      if (contextLines.length < MAX_CONTEXT_LINES) {
        contextLines.push(
          line.length > MAX_CONTEXT_CHARS
            ? `${line.slice(0, MAX_CONTEXT_CHARS)}…`
            : line,
        )
      } else {
        contextWasTruncated = true
      }
    }

    scannedLineCount += 1
    if (newline < 0) {
      cursor = source.length
      break
    }
    cursor = newline + 1
  }

  if (records.length === 0) return null
  return {
    records,
    contextLines,
    scannedLineCount,
    omittedRecordCount,
    contextWasTruncated,
    scanWasTruncated: cursor < source.length,
  }
}

export function parseStructuredJsonSource(source: string): unknown | null {
  if (source.length === 0 || source.length > MAX_JSON_CHARS) return null
  try {
    const value: unknown = JSON.parse(source)
    return typeof value === 'object' && value !== null ? value : null
  } catch {
    return null
  }
}
