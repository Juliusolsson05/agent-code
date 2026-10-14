// Hermes transcript-entry mapper (#1482).
//
// Input: one HermesEntryPayload per committed row, from HermesSession
// (`{hermes: 1, key, storedSessionId, row}`), where `row` is Hermes' own
// TranscriptMessage projection (tui_gateway/contracts/common.py) and `key` is
// hermes-headless's durable identity for it: `row:<row_id>`,
// `tool:<tool_call_id>`, or `notice:…` for a local line Agent Code added.
//
// Output: Claude-shaped feed entries, the shape every shared consumer reads
// (the ledger, Reader Mode, search, View Prompts, the phone). That is the
// whole reason the chat pane can be a new VIEW instead of a new pipeline.
//
// Row shapes as RECORDED (hermes-headless research/corpus, S3/S4/S12):
//   user       {role, text, timestamp, row_id}
//   assistant  {role, text, timestamp, row_id, reasoning?}
//   tool       {role, name, context, tool_call_id, timestamp, args}  ← no row_id,
//              and no result: the resume projection drops tool output.
//
// The mapper is stateless; the turn cursor methods are no-ops.

import type { MappedTranscriptEntry, TranscriptEntryMapper } from '@shared/types/providerConfig'
import type { ContentBlock, Entry } from '@shared/types/transcript'
import { asRecord } from '@shared/lib/asRecord'

/** The SystemEntry type of a local notice (slash output, reconnect notes). */
export const HERMES_NOTICE_ENTRY_TYPE = 'hermes-notice'

/**
 * A skill command is submitted as Hermes' expanded skill text (recorded S13:
 * `command.dispatch` → `{type:'skill', message:'[IMPORTANT: The user has
 * invoked the "<name>" skill…'}`), so the persisted user row is that
 * expansion, not what the user typed.
 */
const SKILL_EXPANSION = /^\[IMPORTANT: The user has invoked the "([^"]+)" skill/

export function createHermesTranscriptEntryMapper(): TranscriptEntryMapper {
  return {
    map: (raw) => mapHermesRow(raw),
    getTurnCursor: () => null,
    setTurnCursor: () => {},
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function isoFromSeconds(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? new Date(value * 1000).toISOString() : undefined
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function mapHermesRow(raw: Record<string, unknown>): MappedTranscriptEntry {
  const key = str(raw.key)
  const row = asRecord(raw.row)
  if (raw.hermes !== 1 || !key || !row) return { entries: [], historyMarker: null }
  const uuid = `hermes:${key}`
  const timestamp = isoFromSeconds(row.timestamp)
  const role = str(row.role)

  // Hermes' own "hidden" rows (display_kind) are context for the model, not
  // conversation; its UIs never show them.
  if (row.display_kind === 'hidden') return { entries: [], historyMarker: key }

  if (role === 'notice') {
    const entry: Entry = { type: HERMES_NOTICE_ENTRY_TYPE, uuid, timestamp, text: textOf(row.text) }
    return { entries: [entry], historyMarker: key }
  }

  if (role === 'user') {
    const text = str(row.text) ?? textOf(row.content)
    if (!text) return { entries: [], historyMarker: key }
    return {
      entries: [{ type: 'user', uuid, parentUuid: null, timestamp, message: { role: 'user', content: [{ type: 'text', text }] } }],
      historyMarker: key,
    }
  }

  if (role === 'assistant') {
    const content: ContentBlock[] = []
    const reasoning = str(row.reasoning)
    if (reasoning) content.push({ type: 'thinking', thinking: reasoning })
    const text = str(row.text) ?? (typeof row.content === 'string' ? row.content : undefined)
    if (text) content.push({ type: 'text', text })
    if (content.length === 0) return { entries: [], historyMarker: key }
    return {
      entries: [{ type: 'assistant', uuid, parentUuid: null, timestamp, message: { role: 'assistant', content } }],
      historyMarker: key,
    }
  }

  if (role === 'tool') {
    const callId = str(row.tool_call_id)
    if (!callId) return { entries: [], historyMarker: key }
    const name = str(row.name) ?? 'tool'
    const input = asRecord(row.args) ?? {}
    // The resume projection carries no tool output (recorded S4). A result
    // row is still emitted, with whatever output exists (often none), so the
    // tool reads as FINISHED after a reload rather than spinning forever: a
    // persisted tool row is by definition a completed call.
    const output = textOf(row.content ?? row.result ?? '')
    return {
      entries: [
        { type: 'assistant', uuid, parentUuid: null, timestamp, message: { role: 'assistant', content: [{ type: 'tool_use', id: callId, name, input }] } },
        { type: 'user', uuid: `${uuid}:result`, parentUuid: null, timestamp, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, content: output, is_error: false }] } },
      ],
      historyMarker: key,
    }
  }

  return { entries: [], historyMarker: key }
}

/** The skill a persisted user row invoked, when it is a skill expansion. */
export function hermesSkillInvocation(text: string): string | null {
  return SKILL_EXPANSION.exec(text)?.[1] ?? null
}

/**
 * A user row is typed input unless it is Hermes' expansion of a skill command
 * (which View Prompts and prompt history must not offer back verbatim).
 */
export function isHermesTypedUserPrompt(_entry: Entry, text: string): boolean {
  return hermesSkillInvocation(text) === null
}

export function extractHermesProviderSessionId(raw: Record<string, unknown>): string | null {
  return raw.hermes === 1 && typeof raw.storedSessionId === 'string' && raw.storedSessionId ? raw.storedSessionId : null
}
