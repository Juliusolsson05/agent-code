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

/** A unit of the agent's work between two messages: a thought or a tool call. */
export type ChatStep = Extract<ChatItem, { kind: 'reasoning' | 'tool' }>

/** What the chat draws: messages as they are, every run of work folded into one row. */
export type ChatRowItem = Exclude<ChatItem, ChatStep> | { kind: 'activity'; key: string; steps: ChatStep[] }

/**
 * Fold every run of consecutive reasoning/tool items into ONE activity row.
 *
 * WHY (the owner's real conversation, debug bundle 2026-10-14T16-26-49): 425
 * rows, of which 21 were prompts, 61 replies and 342 (80%) were reasoning
 * disclosures and tool chips, stacked one per row. A four-command lookup put
 * nine rows between the question and its answer. In a chat the work is
 * supporting detail: the reader wants to see THAT the agent worked (and what
 * it is doing right now), and open the detail only when something looks
 * wrong. So a run of work is one quiet line, and the messages read as a
 * conversation again.
 *
 * The run is maximal: it ends only at something the reader reads (a prompt,
 * a reply, a notice). Splitting it at reasoning/tool boundaries would bring
 * back the stripes this removes.
 *
 * The key is the FIRST step's key: a live run grows at its end, so its row
 * keeps its identity (and its open/closed state) while tools stream in.
 * EXCEPT at the live → committed hand-off (review A F3): the ledger keys a
 * live step `semantic-block:<turn>:<idx>` and the committed one
 * `entry:<uuid>:…`, so when the turn commits the row remounts and an opened
 * run closes. Before folding, every chip did the same; keying by something
 * that survives the hand-off (turn id, first toolUseId) is possible if that
 * ever matters, but the ledger key is not it.
 * Steps are the stabilized items (stabilizeChat ran first), so `sameRow`
 * can compare them by identity.
 */
export function groupActivity(chat: readonly ChatItem[], previous: readonly ChatRowItem[] | null = null): ChatRowItem[] {
  const out: ChatRowItem[] = []
  let run: ChatStep[] | null = null
  for (const item of chat) {
    if (item.kind === 'reasoning' || item.kind === 'tool') {
      if (run) run.push(item)
      else {
        run = [item]
        out.push({ kind: 'activity', key: `activity:${item.key}`, steps: run })
      }
      continue
    }
    run = null
    out.push(item)
  }
  if (!previous || previous.length === 0) return out
  // Same row reuse as stabilizeChat, so memo(ChatRow) skips a finished run
  // while the next reply streams below it.
  const byKey = new Map(previous.map((row) => [row.key, row]))
  return out.map((row) => {
    const before = byKey.get(row.key)
    if (!before) return row
    if (row.kind === 'activity') {
      return before.kind === 'activity' && before.steps.length === row.steps.length && before.steps.every((step, i) => step === row.steps[i]) ? before : row
    }
    return before === row ? before : row
  })
}

/**
 * The one line a folded run shows: what the agent did, at a glance.
 *
 * Tool names are counted, not listed per call (109 of the owner's 206 chips
 * were `terminal`; "terminal ×4" says it, four rows did not). The headline is
 * what is happening NOW while the run is live (the running tool's label), and
 * the agent's own latest heading once it is done, because that heading is
 * the model's summary of the step ("Checking Gmail watcher cron status").
 *
 * `progress` is the LATEST progress update the agent wrote inside its
 * reasoning (splitReasoning). It stays visible under the folded line: it is
 * the agent talking to the reader ("I'm running a full live audit now…"), and
 * hiding it is what made the owner ask "what is going on?" (see
 * splitReasoning). Only the latest one, because each update supersedes the
 * one before it.
 */
export function summarizeActivity(steps: readonly ChatStep[]): {
  status: ChatToolStatus
  tools: string
  headline: string
  thoughts: number
  failed: number
  progress: string
} {
  const counts = new Map<string, number>()
  let thoughts = 0
  let failed = 0
  let headline = ''
  let progress = ''
  let runningTool: Extract<ChatStep, { kind: 'tool' }> | null = null
  let thinking = false
  let lastTool: Extract<ChatStep, { kind: 'tool' }> | null = null
  for (const step of steps) {
    if (step.kind === 'tool') {
      counts.set(step.name, (counts.get(step.name) ?? 0) + 1)
      lastTool = step
      if (step.status === 'error') failed += 1
      if (step.status === 'running') runningTool = step
    } else {
      thoughts += 1
      if (step.streaming) thinking = true
      const { headings, prose } = splitReasoning(step.text)
      // A thought sets the headline whether it is finished or still
      // streaming (review A F1): the usual live shape is "a tool returned,
      // now the model thinks", and gating on `streaming` left the line on the
      // PREVIOUS step's heading, or empty, for that whole thought.
      if (headings.length > 0) headline = headings[headings.length - 1]!
      if (prose) progress = prose
    }
  }
  // A running tool is what is happening now; it outranks any heading.
  if (runningTool) headline = runningTool.label ? `${runningTool.name} ${runningTool.label}` : runningTool.name
  // Ruling (review A F4, owner call UNCONFIRMED): ✕ only when the run's LAST
  // tool failed. Agents routinely probe, fail, and retry; S4 itself runs a
  // failing read and then a working one before answering. A run that ends in
  // a correct answer under a red ✕ reads as "the work failed". Earlier
  // failures still show, as "N failed" in the counts.
  const status: ChatToolStatus = runningTool || thinking ? 'running' : lastTool?.status === 'error' ? 'error' : 'done'
  const tools = [...counts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(', ')
  return { status, tools, headline, thoughts, failed, progress }
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
