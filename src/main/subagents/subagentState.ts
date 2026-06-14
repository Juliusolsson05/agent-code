import type { SubAgentState, SubAgentToolCall } from '@preload/api/types.js'

// Pure builder: turns a subagent's parsed transcript entries + its meta into a
// SubAgentState for the renderer. No I/O here so the logic is trivially
// testable and the watcher stays a thin file-tailing shell.
//
// WHY we parse JSON ourselves instead of using agent-transcript-parser: that
// package is a Claude<->Codex *converter*, not a JSONL reader. These files are
// already in Claude transcript shape, so we just JSON.parse each line and read
// the tool_use / tool_result blocks. The shapes below are intentionally
// permissive — a partial/edge entry must never throw.

/** Cap the timeline so a 300 KB+ subagent transcript can't bloat the IPC
 *  payload we push on every change. Keep the most-recent N; surface the rest
 *  as a "+N earlier" count rather than silently dropping them. */
export const SUBAGENT_TOOL_CALLS_MAX = 40

type RawBlock = {
  type?: string
  name?: string
  id?: string
  tool_use_id?: string
  is_error?: boolean
  input?: Record<string, unknown>
}
type RawEntry = {
  type?: string
  timestamp?: string
  message?: { role?: string; content?: unknown }
}

export type SubAgentMeta = {
  agentType?: string
  description?: string
  toolUseId?: string
}

function headlineFromInput(
  input: Record<string, unknown> | undefined,
): string | null {
  if (!input) return null
  // Same priority ToolUseRow uses for its `⎿` sub-line, so a subagent's
  // mini-feed reads like the main feed.
  for (const k of [
    'command',
    'file_path',
    'path',
    'pattern',
    'query',
    'url',
    'description',
  ]) {
    const v = input[k]
    if (typeof v === 'string' && v.length > 0) {
      return v.length > 80 ? v.slice(0, 80) + '…' : v
    }
  }
  return null
}

function tsToMs(ts: string | undefined): number | null {
  if (!ts) return null
  const n = Date.parse(ts)
  return Number.isFinite(n) ? n : null
}

/**
 * Build a SubAgentState from a subagent transcript's parsed entries + meta.
 *
 * @param toolUseId   parent `Agent` tool_use id (authoritative join key)
 * @param agentId     the agent-<id> filename id
 * @param meta        contents of agent-<id>.meta.json (may be partial)
 * @param entries     parsed JSONL lines of agent-<id>.jsonl
 * @param parentDone  true if the parent transcript has a tool_result for toolUseId
 * @param parentError true if that parent tool_result is an error
 */
export function buildSubAgentState(
  toolUseId: string,
  agentId: string,
  meta: SubAgentMeta,
  entries: RawEntry[],
  parentDone: boolean,
  parentError: boolean,
): SubAgentState {
  type Call = SubAgentToolCall & { id: string | null }
  const calls: Call[] = []
  const resultIds = new Set<string>()
  let turnCount = 0
  let firstTs: number | null = null
  let lastTs: number | null = null
  let lastActivity: string | null = null

  for (const e of entries) {
    const ms = tsToMs(e.timestamp)
    if (ms != null) {
      if (firstTs == null) firstTs = ms
      lastTs = ms
    }
    const content = e.message?.content
    if (!Array.isArray(content)) continue
    if (e.type === 'assistant') turnCount += 1
    for (const b of content as RawBlock[]) {
      if (b.type === 'tool_use') {
        calls.push({
          id: typeof b.id === 'string' ? b.id : null,
          name: b.name ?? 'tool',
          headline: headlineFromInput(b.input),
          status: 'running',
        })
        lastActivity = `running ${b.name ?? 'tool'}`
      } else if (
        b.type === 'tool_result' &&
        typeof b.tool_use_id === 'string'
      ) {
        resultIds.add(b.tool_use_id)
        // The subagent's own tool call resolved — clear the activity hint so a
        // long gap before its next action doesn't read as "still running X".
        lastActivity = null
      } else if (b.type === 'thinking') {
        lastActivity = 'thinking'
      }
    }
  }

  // Resolve each call's completion precisely by id (subagent transcripts carry
  // their own tool_result blocks). Calls without an id stay 'running'.
  for (const c of calls) {
    c.status = c.id && resultIds.has(c.id) ? 'done' : 'running'
  }

  // Cap to the most recent N, recording how many we dropped off the front.
  let dropped = 0
  let kept: Call[] = calls
  if (calls.length > SUBAGENT_TOOL_CALLS_MAX) {
    dropped = calls.length - SUBAGENT_TOOL_CALLS_MAX
    kept = calls.slice(dropped)
  }
  const toolCalls: SubAgentToolCall[] = kept.map(({ name, headline, status }) => ({
    name,
    headline,
    status,
  }))

  const status: SubAgentState['status'] = parentError
    ? 'error'
    : parentDone
      ? 'done'
      : 'running'

  return {
    toolUseId,
    agentId,
    agentType: meta.agentType ?? 'agent',
    description: meta.description ?? '',
    status,
    startedAt: firstTs,
    lastActivityAt: lastTs,
    turnCount,
    toolCalls,
    droppedToolCalls: dropped,
    currentActivity: status === 'running' ? lastActivity : null,
  }
}
