import { stripAnsi } from '@shared/parsers/ansi'
import { RESERVED_USER_MCP_NAMES } from '@shared/userMcp/types'
import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'

import { prettifyToolName, smartHeadline } from '@providers/shared/renderer/rows/jsonToolPresentation'

// One MCP tool call as ONE line (#1519): `◆ goal_set  "…"  ✓`.
//
// WHY: generic MCP calls are 14% of the owner's Claude tool calls (last 40
// transcripts, 2026-10-14: 885 of 6,251), and every one painted three rows
// — the name with an "MCP · agent_code" chip, a "▸ 1 param" disclosure, and
// a "▸ ok: true" result disclosure — for what is often an acknowledgement.
// The owner's ask was the same line language as the Codex script steps
// (#1510): what ran, what it was about, and a verdict.
//
// Provider-NEUTRAL on purpose: the MCP CallToolResult shape is the protocol's,
// not Claude's, so OpenCode or Pi rows can admit the same model later.
//
// What may be ABSORBED, i.e. what the line alone fully carries (review of
// #1520 — `ok:true` is Agent Code's success envelope for nearly EVERY tool,
// reads included, so "ok:true" is not "nothing to show"):
//   - an ACKNOWLEDGEMENT: Agent Code's own server, one text part, and an
//     envelope with no keys beyond the recorded acknowledgement shape
//     (goal_set / tldr_update: ok, text, updatedAt, revision);
//   - an error or a refusal: the line shows its sentence and the line's
//     disclosure holds the full result text, so nothing is lost.
// Any other result — a read's payload, a third-party server's reply, an
// image — keeps the shared result row.

export type McpCallOutcome = 'pending' | 'no-result' | 'ok' | 'refused' | 'error' | 'declined' | 'content'

export type McpCallModel = {
  tool: string
  server: string
  /** Agent Code's own server: no server chip (a third party's same-named tool keeps one). */
  ownServer: boolean
  /** The call's one-line subject. */
  detail: string | null
  outcome: McpCallOutcome
  /** A refusal's code (`error` field), when it has one. */
  code: string | null
  /** A refusal's or an error's own sentence, ANSI stripped and bounded. */
  message: string | null
  /** The full result text for the disclosure, when the line absorbs the result row. */
  resultText: string | null
  /** True when the line fully carries the result, so its row may be absorbed. */
  absorbsResult: boolean
}

const MESSAGE_MAX = 400
export const DISCLOSURE_MAX = 16 * 1024
/** An acknowledgement is tiny by definition; anything larger is not parsed (review B8). */
const ACK_PARSE_MAX = 4 * 1024
const ACK_KEYS = new Set(['ok', 'text', 'updatedAt', 'revision', 'completedAt'])
const DETAIL_SCAN_KEYS = 40

export function fromMcpCall(toolUse: ToolUseBlock, result: ToolResultBlock | null, options: { live?: boolean } = {}): McpCallModel | null {
  const { display, mcpServer } = prettifyToolName(toolUse.name)
  if (!mcpServer) return null
  const base = {
    tool: display,
    server: mcpServer,
    ownServer: (RESERVED_USER_MCP_NAMES as readonly string[]).includes(mcpServer),
    detail: detailOf(toolUse.input),
    code: null,
    message: null,
    resultText: null,
  }
  if (!result || result.tool_use_id !== toolUse.id) {
    // Waiting only while live; a committed call with no result (a session
    // killed mid-call) must not read as "still running" forever (review B2).
    return { ...base, outcome: options.live ? 'pending' : 'no-result', absorbsResult: false }
  }
  const single = singleText(result.content)
  const text = single ?? ''
  // The line may absorb only what its disclosure holds IN FULL. Past
  // DISCLOSURE_MAX the disclosure is cut, so the shared result row (which
  // pages the whole text) must stay, or the tail is unreachable (review of
  // #1523, which found this in the housekeeping line and here).
  const fits = single !== null && single.length <= DISCLOSURE_MAX
  if (result.is_error === true) {
    if (single !== null && isUserDecline(text)) {
      // The user declined or interrupted it: a choice, not a tool failure (review B4).
      return { ...base, outcome: 'declined', message: bounded(text), resultText: forDisclosure(text), absorbsResult: fits }
    }
    const envelope = single !== null ? envelopeOf(text) : null
    return {
      ...base,
      outcome: 'error',
      message: single !== null ? bounded(envelope?.message ?? text) : null,
      code: envelope?.code ?? null,
      resultText: single !== null ? forDisclosure(text) : null,
      // Absorb only what the disclosure fully holds (one text part, not cut).
      absorbsResult: fits,
    }
  }
  const envelope = single !== null ? envelopeOf(text) : null
  if (envelope?.ok === false) {
    return { ...base, outcome: 'refused', message: bounded(envelope.message ?? text), code: envelope.code, resultText: forDisclosure(text), absorbsResult: fits }
  }
  if (envelope?.ok === true) {
    const acknowledgement = base.ownServer && envelope.keys.every((key) => ACK_KEYS.has(key))
    return { ...base, outcome: 'ok', absorbsResult: acknowledgement }
  }
  return { ...base, outcome: 'content', absorbsResult: false }
}

/** The one text of a string or a single `{type:'text'}` part; null for anything else (an image, several parts). */
export function singleText(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (Array.isArray(content) && content.length === 1) {
    const part = content[0] as { type?: unknown; text?: unknown } | null
    if (part && part.type === 'text' && typeof part.text === 'string') return part.text
  }
  return null
}

function envelopeOf(text: string): { ok: boolean | null; message: string | null; code: string | null; keys: string[] } | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') || trimmed.length > ACK_PARSE_MAX) {
    // Too large to be an envelope worth parsing on a render: read its first
    // fields lexically so a big refusal still says it refused.
    const ok = /^\{\s*"ok"\s*:\s*(true|false)/.exec(trimmed)
    return ok ? { ok: ok[1] === 'true', message: null, code: null, keys: ['ok', '…'] } : null
  }
  try {
    const value = JSON.parse(trimmed) as Record<string, unknown>
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    return {
      ok: typeof value.ok === 'boolean' ? value.ok : null,
      message: typeof value.message === 'string' ? value.message : null,
      code: typeof value.error === 'string' ? value.error : typeof value.code === 'string' ? value.code : null,
      keys: Object.keys(value),
    }
  } catch {
    return null
  }
}

/** Claude Code's own words when the user declined a tool or interrupted it. */
export function isUserDecline(text: string): boolean {
  return /^The user doesn't want to proceed with this tool use/.test(text) || /^\[Request interrupted by user/.test(text)
}

function detailOf(input: unknown): string | null {
  const record = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : null
  const headline = smartHeadline(record)?.value
  if (headline) return oneLine(headline)
  // Agent Code's reporting tools carry their subject in `text`, which the
  // generic chain does not pick. Bounded: a generated input can have
  // thousands of keys (jsonToolPresentation's budget, review B8).
  if (!record) return null
  let scanned = 0
  for (const key in record) {
    if (++scanned > DETAIL_SCAN_KEYS) break
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return oneLine(value)
  }
  return null
}

export function oneLine(text: string): string {
  const line = text.slice(0, 400).replace(/\s+/g, ' ').trim()
  return line.length > 160 ? `${line.slice(0, 159)}…` : line
}

export function bounded(text: string): string {
  const clean = stripAnsi(text.slice(0, MESSAGE_MAX * 4)).trim()
  return clean.length > MESSAGE_MAX ? `${clean.slice(0, MESSAGE_MAX - 1)}…` : clean
}

export function forDisclosure(text: string): string {
  const clean = stripAnsi(text.length > DISCLOSURE_MAX ? text.slice(0, DISCLOSURE_MAX) : text)
  return text.length > DISCLOSURE_MAX ? `${clean}\n… (truncated, ${text.length.toLocaleString()} characters)` : clean
}
