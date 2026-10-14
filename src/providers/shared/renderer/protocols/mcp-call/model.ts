import { stripAnsi } from '@shared/parsers/ansi'
import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'

import { prettifyToolName, smartHeadline } from '@providers/shared/renderer/rows/jsonToolPresentation'

// One MCP tool call as ONE line (#1519): `◆ goal_set  "…"  ✓`.
//
// WHY: generic MCP calls are 14% of the owner's Claude tool calls (last 40
// transcripts, 2026-10-14: 885 of 6,251), and every one painted three rows
// — the name with an "MCP · agent_code" chip, a "▸ 1 param" disclosure, and
// a "▸ ok: true" result disclosure — for what is usually an acknowledgement.
// The owner's ask was the same line language as the Codex script steps
// (#1510): what ran, what it was about, and a verdict.
//
// Provider-NEUTRAL on purpose: the MCP CallToolResult shape is the protocol's,
// not Claude's, so OpenCode or Pi rows can admit the same model later.
//
// What may be ABSORBED: only an acknowledgement, a result whose whole text is
// JSON with `ok: true` (Agent Code's own tool envelope). The ✓ says it; the
// call's arguments are still one click away in the row. Everything else (an
// error, a refusal, real content) stays visible: a refusal and an error show
// their own sentence; content keeps the shared result rendering.

export type McpCallOutcome = 'pending' | 'ok' | 'refused' | 'error' | 'content'

export type McpCallModel = {
  tool: string
  server: string
  /** The call's one-line subject (the same headline the generic row picks). */
  detail: string | null
  outcome: McpCallOutcome
  /** A refusal's or an error's own sentence, ANSI stripped and bounded. */
  message: string | null
  /** True only for an ok acknowledgement: the result row may be absorbed. */
  acknowledgement: boolean
}

const MESSAGE_MAX = 400

export function fromMcpCall(toolUse: ToolUseBlock, result: ToolResultBlock | null): McpCallModel | null {
  const { display, mcpServer } = prettifyToolName(toolUse.name)
  if (!mcpServer) return null
  const input = toolUse.input && typeof toolUse.input === 'object' ? (toolUse.input as Record<string, unknown>) : null
  // The generic row's headline keys first; then the first string argument,
  // because Agent Code's own reporting tools (goal_set, tldr_update) carry
  // their whole subject in `text`, which the generic chain does not pick.
  const headline = smartHeadline(input)?.value ?? Object.values(input ?? {}).find((value): value is string => typeof value === 'string' && value.trim().length > 0)
  const detail = headline ? oneLine(headline) : null
  const base = { tool: display, server: mcpServer, detail }
  if (!result || result.tool_use_id !== toolUse.id) return { ...base, outcome: 'pending', message: null, acknowledgement: false }
  const text = resultText(result.content)
  const envelope = parseEnvelope(text)
  if (result.is_error === true) {
    return { ...base, outcome: 'error', message: bounded(envelope?.message ?? text), acknowledgement: false }
  }
  if (envelope?.ok === true && text.trim().startsWith('{')) return { ...base, outcome: 'ok', message: null, acknowledgement: true }
  if (envelope?.ok === false) return { ...base, outcome: 'refused', message: bounded(envelope.message ?? text), acknowledgement: false }
  return { ...base, outcome: 'content', message: null, acknowledgement: false }
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : '')).join('\n')
}

/** Agent Code's tool envelope, `{ok, message?, …}`, when the WHOLE text is one. */
function parseEnvelope(text: string): { ok: boolean | null; message: string | null } | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    const value = JSON.parse(trimmed) as Record<string, unknown>
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    return { ok: typeof value.ok === 'boolean' ? value.ok : null, message: typeof value.message === 'string' ? value.message : null }
  } catch {
    return null
  }
}

function oneLine(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > 160 ? `${line.slice(0, 159)}…` : line
}

function bounded(text: string): string {
  const clean = stripAnsi(text).trim()
  return clean.length > MESSAGE_MAX ? `${clean.slice(0, MESSAGE_MAX - 1)}…` : clean
}
