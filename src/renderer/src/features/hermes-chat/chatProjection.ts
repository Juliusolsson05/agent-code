// Feed items → chat items for the Hermes pane (#1482).
//
// The chat is a VIEW over the same rows the coding feed and Reader Mode draw:
// `useLedgerFeedItems` (via TileLeaf's feed model) has already decided, for
// every visible unit, whether the committed row or the live semantic block
// owns it (rendering/model/ledger.ts). This projection only changes how those
// owners LOOK: bubbles instead of rows, tool calls as chips. It must never
// decide ownership itself. A second dedupe here is exactly the "two sources
// fighting" bug class the ledger exists to end (decomposition §9).
//
// Pure, so it is tested by folding recorded Hermes frames through the real
// ledger (chatProjection.renderer.test.ts).

import type { FeedRenderItem } from '@renderer/features/feed/model/renderModel'
import type { ContentBlock, Entry } from '@shared/types/transcript'
import { hermesSkillInvocation, HERMES_NOTICE_ENTRY_TYPE } from '@providers/hermes/renderer/transcript/mapper'

export type ChatToolStatus = 'running' | 'done' | 'error'

export type ChatItem =
  | { kind: 'user'; key: string; text: string; skill: string | null }
  // `uuid`: the committed entry's id, which the Copy Assistant Message picker
  // selects by (runtime.assistantPicker.selectedUuid). Live blocks have none.
  | { kind: 'assistant'; key: string; text: string; streaming: boolean; uuid?: string }
  | { kind: 'reasoning'; key: string; text: string; streaming: boolean }
  | { kind: 'tool'; key: string; toolUseId: string; name: string; label: string; status: ChatToolStatus; input: Record<string, unknown>; result: string | null }
  | { kind: 'notice'; key: string; text: string }
  | { kind: 'typing'; key: string; label: string }
  | { kind: 'empty'; key: string }

/**
 * A one-line label for a tool chip, from its arguments. Hermes' own one-liner
 * (`tool.start.context`, e.g. "sleep 3 + 1 command") is not kept by the fold,
 * so both the live chip and the reloaded one derive it from the same args and
 * read identically.
 */
export function hermesToolLabel(name: string, input: Record<string, unknown>): string {
  const pick = (...keys: string[]) => keys.map((key) => input[key]).find((value): value is string => typeof value === 'string' && value.trim().length > 0)
  const questions = Array.isArray(input.questions) ? input.questions : null
  const firstQuestion = questions && questions[0] && typeof questions[0] === 'object' ? (questions[0] as { question?: unknown }).question : undefined
  const label =
    (name === 'terminal' && pick('command')) ||
    pick('path', 'file_path') ||
    pick('query', 'url', 'name') ||
    (typeof firstQuestion === 'string' ? firstQuestion : undefined) ||
    Object.values(input).find((value): value is string => typeof value === 'string' && value.length > 0) ||
    ''
  const line = label.replace(/\s+/g, ' ').trim()
  return line.length > 90 ? `${line.slice(0, 89)}…` : line
}

function textOfBlocks(blocks: ContentBlock[]): string {
  return blocks.filter((block) => block.type === 'text').map((block) => (block as { text: string }).text).join('\n\n').trim()
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((part) => (part && typeof part === 'object' && 'text' in part ? String((part as { text: unknown }).text) : '')).join('')
  }
  return content === null || content === undefined ? '' : JSON.stringify(content)
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

/** Committed tool results by call id: they arrive as separate user rows and belong on their chip. */
function committedResults(items: readonly FeedRenderItem[]): Map<string, { text: string; isError: boolean }> {
  const results = new Map<string, { text: string; isError: boolean }>()
  for (const item of items) {
    if (item.type !== 'entry') continue
    const message = (item.entry as { message?: { content?: unknown } }).message
    if (!Array.isArray(message?.content)) continue
    for (const block of message.content as ContentBlock[]) {
      if (block.type !== 'tool_result') continue
      const result = block as { tool_use_id: string; content: unknown; is_error?: boolean }
      results.set(result.tool_use_id, { text: toolResultText(result.content), isError: result.is_error === true })
    }
  }
  return results
}

function entryItems(entry: Entry, key: string, results: Map<string, { text: string; isError: boolean }>): ChatItem[] {
  if (entry.type === HERMES_NOTICE_ENTRY_TYPE) {
    const text = (entry as unknown as { text?: unknown }).text
    return typeof text === 'string' && text ? [{ kind: 'notice', key, text }] : []
  }
  const message = (entry as { message?: { role?: string; content?: unknown } }).message
  if (!message || !Array.isArray(message.content)) return []
  const blocks = message.content as ContentBlock[]
  if (entry.type === 'user') {
    // A user row that only carries tool results is plumbing, drawn on chips.
    const text = textOfBlocks(blocks)
    if (!text) return []
    return [{ kind: 'user', key, text, skill: hermesSkillInvocation(text) }]
  }
  if (entry.type !== 'assistant') return []
  const out: ChatItem[] = []
  for (const [index, block] of blocks.entries()) {
    if (block.type === 'thinking') {
      const text = (block as { thinking?: string }).thinking ?? ''
      if (text.trim()) out.push({ kind: 'reasoning', key: `${key}:r${index}`, text, streaming: false })
    } else if (block.type === 'text') {
      const text = (block as { text: string }).text.trim()
      if (text) out.push({ kind: 'assistant', key: `${key}:t${index}`, text, streaming: false, ...(entry.uuid ? { uuid: entry.uuid } : {}) })
    } else if (block.type === 'tool_use') {
      const tool = block as { id: string; name: string; input?: unknown }
      const input = asRecord(tool.input)
      const result = results.get(tool.id)
      out.push({
        kind: 'tool',
        key: `${key}:u${index}`,
        toolUseId: tool.id,
        name: tool.name,
        label: hermesToolLabel(tool.name, input),
        // A committed tool row is a finished call: Hermes persists it after
        // the tool returns (the resume projection carries no result, S4).
        status: result?.isError ? 'error' : 'done',
        input,
        result: result?.text ? result.text : null,
      })
    }
  }
  return out
}

export function projectChat(items: readonly FeedRenderItem[]): ChatItem[] {
  const results = committedResults(items)
  const out: ChatItem[] = []
  for (const item of items) {
    switch (item.type) {
      case 'entry':
        out.push(...entryItems(item.entry, item.key, results))
        break
      case 'semantic-text':
        if (item.text.trim()) out.push({ kind: 'assistant', key: item.key, text: item.text.trim(), streaming: item.owner === 'semantic-current' })
        break
      case 'semantic-block': {
        const block = item.block
        const live = item.owner === 'semantic-current'
        if (block.kind === 'text') {
          const text = (block.text ?? '').trim()
          if (text) out.push({ kind: 'assistant', key: item.key, text, streaming: live && !block.finalized })
        } else if (block.kind === 'thinking') {
          const text = block.thinking || block.text || ''
          if (text.trim()) out.push({ kind: 'reasoning', key: item.key, text, streaming: live && !block.finalized })
        } else if (block.kind === 'tool_use' || block.kind === 'mcp_tool_use') {
          const input = block.parsedInput ?? {}
          const name = block.toolName ?? 'tool'
          out.push({
            kind: 'tool',
            key: item.key,
            toolUseId: block.toolUseId ?? item.key,
            name,
            label: hermesToolLabel(name, input),
            status: block.resultAt == null ? 'running' : block.resultIsError ? 'error' : 'done',
            input,
            result: block.resultContent ? block.resultContent : null,
          })
        }
        break
      }
      case 'semantic-collapsed-activity':
        out.push({ kind: 'notice', key: item.key, text: `${item.unit.count} tool calls${item.unit.isRunning ? ' (running)' : ''}` })
        break
      case 'work':
        out.push({ kind: 'typing', key: item.key, label: item.toolName ? `Running ${item.toolName}` : 'Hermes is thinking' })
        break
      case 'provider-notice':
        out.push({ kind: 'notice', key: item.key, text: item.notice.title })
        break
      case 'transport-gap':
        out.push({ kind: 'notice', key: item.key, text: 'Part of this reply was not received.' })
        break
      case 'transport-interruption':
        out.push({ kind: 'notice', key: item.key, text: 'The reply stopped before it finished.' })
        break
      case 'sleep-interruption':
        out.push({ kind: 'notice', key: item.key, text: 'The reply was interrupted while this Mac was asleep.' })
        break
      case 'empty':
        out.push({ kind: 'empty', key: item.key })
        break
      case 'absorbed-entry':
        break
    }
  }
  return out
}

/**
 * Reuse the previous render's item object for every row whose content did not
 * change, so `memo(ChatRow)` actually skips it.
 *
 * WHY (spotlight investigation, #1499): projectChat builds a NEW object for
 * every row on every call, and while a reply streams `items` changes on every
 * token, so every row of the conversation re-rendered per token (tool output
 * re-escaped by withVisibleControls, char by char) in each live copy of the
 * pane. Spotlight keeps two. Field-by-field `===` is exact for the scalars;
 * a tool's `input` is the ledger's parsed object, which keeps its identity
 * while its block is unchanged, so `===` there is the cheap correct test.
 */
export function stabilizeChat(previous: readonly ChatItem[] | null, next: ChatItem[]): ChatItem[] {
  if (!previous || previous.length === 0) return next
  const byKey = new Map(previous.map((item) => [item.key, item]))
  let reused = 0
  const out = next.map((item) => {
    const before = byKey.get(item.key)
    if (before && sameItem(before, item)) {
      reused += 1
      return before
    }
    return item
  })
  return reused === 0 ? next : out
}

function sameItem(a: ChatItem, b: ChatItem): boolean {
  if (a.kind !== b.kind) return false
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(right)
  if (Object.keys(left).length !== keys.length) return false
  return keys.every((key) => left[key] === right[key])
}

/**
 * A reasoning block's readable part, split from its headings.
 *
 * Recorded in the owner's debug bundle (2026-10-14T16-26-49, Codex route):
 * Hermes stores the model's progress updates INSIDE `reasoning`, as a run of
 * bold summary headings followed by prose, e.g.
 *   "**Auditing comprehensive Hermes setup** **Checking Gmail watcher cron
 *    status** I'm running a full live audit now: model/auth, gateway, …"
 * The prose is the agent telling the user what it is doing; live it streamed
 * as answer text, but once committed it sat in a COLLAPSED "Reasoning"
 * block, so the owner asked "what is going on?" while the answer was on
 * screen, hidden. The headings stay in the disclosure; the prose is shown.
 */
export function splitReasoning(text: string): { headings: string[]; prose: string } {
  const headings: string[] = []
  let rest = text.trim()
  for (;;) {
    const match = /^\*\*([^*\n]+)\*\*\s*/.exec(rest)
    if (!match) break
    headings.push(match[1]!.trim())
    rest = rest.slice(match[0].length)
  }
  return { headings, prose: headings.length > 0 ? rest.trim() : '' }
}

/**
 * A tool result as a person reads it. Hermes' tools answer JSON envelopes
 * (owner's debug bundle: `{"output":"…","exit_code":0,"error":null}` for
 * terminal, `{"content":"1|…","total_lines":2670,…}` for read_file), which
 * the chip showed as one escaped line with `\n` everywhere. The common
 * envelopes show their text; anything else is pretty-printed JSON; non-JSON
 * is shown as is.
 */
export function formatToolResult(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return raw
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return raw
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>
    const body = typeof record.output === 'string' ? record.output : typeof record.content === 'string' ? record.content : null
    if (body !== null) {
      const notes: string[] = []
      if (typeof record.exit_code === 'number' && record.exit_code !== 0) notes.push(`exit code ${record.exit_code}`)
      if (typeof record.error === 'string' && record.error) notes.push(`error: ${record.error}`)
      if (record.truncated === true) notes.push('truncated')
      return notes.length > 0 ? `${body}\n\n(${notes.join(' · ')})` : body
    }
  }
  return JSON.stringify(parsed, null, 2)
}
