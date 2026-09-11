import { access } from 'node:fs/promises'
import { constants } from 'node:fs'

import { parseOpencodeTranscriptFile, type OpencodeStore } from 'opencode-terminal-headless'

import { streamJsonl } from '@shared/runtime/streamJsonl.js'
import {
  asRecord as asSharedRecord,
  parseJsonRecord,
} from '@shared/lib/asRecord.js'
import type {
  AgentTranscriptErrorResult,
  AgentTranscriptIncludeOptions,
  AgentTranscriptInspectResult,
  AgentTranscriptItem,
  AgentTranscriptItemKind,
  AgentTranscriptProjection,
  AgentTranscriptProvider,
  AgentTranscriptProviderInput,
  AgentTranscriptReadResult,
  AgentTranscriptSearchResult,
  AgentTranscriptStats,
} from '@mcp/shared/agentTranscriptTypes.js'
import { opencodeDatabase, type OpencodeDatabase } from '@providers/opencode/runtime/opencodeDatabase.js'

type JsonRecord = Record<string, unknown>

type ReadFileOptions = {
  path: string
  provider?: AgentTranscriptProviderInput
  projection: AgentTranscriptProjection
  include?: AgentTranscriptIncludeOptions
  tail?: number
  maxItems?: number
  maxChars?: number
  maxCharsPerItem?: number
}

type SearchFileOptions = {
  path: string
  provider?: AgentTranscriptProviderInput
  query: string
  kinds?: AgentTranscriptItemKind[]
  maxMatches?: number
  contextItems?: number
  maxCharsPerMatch?: number
}

type InspectFileOptions = {
  path: string
  provider?: AgentTranscriptProviderInput
}

/**
 * Where OpenCode sessions are read from. Injectable so tests read a fixture
 * database; production reads OpenCode's own through the app's shared handle.
 */
export type AgentTranscriptReaderDeps = {
  opencode: OpencodeDatabase
}

const DEFAULT_DEPS: AgentTranscriptReaderDeps = { opencode: opencodeDatabase }

// A transcript this reader can stream, as normalized records.
//
// WHY two sources behind one reducer set: Claude and Codex keep one JSONL
// file per session; OpenCode keeps every session in one SQLite database, so
// its transcript is named by an `opencode://session/<id>` locator (the one
// both OpenCode runtimes publish on every committed entry). The projection,
// search and inspect reducers only need "the session's records, oldest
// first", so the source is the only thing that knows which it is. Each
// OpenCode record is one whole message, `{ info, parts }`, walked a page at
// a time so a long session is never held in memory, matching the JSONL
// streaming the reducers were built around.
type TranscriptSource =
  | { kind: 'jsonl'; path: string }
  | { kind: 'opencode'; path: string; sessionID: string; store: OpencodeStore }

type PreparedTranscript = {
  ok: true
  source: TranscriptSource
  provider: AgentTranscriptProvider
}

const DEFAULT_MAX_ITEMS = 100
const DEFAULT_MAX_CHARS = 24_000
const DEFAULT_MAX_CHARS_PER_ITEM = 4_000
const DEFAULT_SEARCH_MATCHES = 25
const DEFAULT_SEARCH_CONTEXT_ITEMS = 1
const DEFAULT_SEARCH_CHARS_PER_MATCH = 2_000

// The `tool` of an item that carries a tool's raw OUTPUT rather than a call.
// Hidden from projections and search unless `include.rawToolOutputs`, because
// outputs dwarf everything else and are rarely what a reader of another
// agent's work wants. The name is Codex's (its outputs are
// `function_call_output` records); OpenCode's tool outputs use the same
// marker so one flag governs every provider.
const RAW_TOOL_OUTPUT = 'function_call_output'

export async function readAgentTranscriptFile(
  options: ReadFileOptions,
  deps: AgentTranscriptReaderDeps = DEFAULT_DEPS,
): Promise<AgentTranscriptReadResult | AgentTranscriptErrorResult> {
  const prepared = await prepareTranscript(options.path, options.provider ?? 'auto', deps)
  if (!prepared.ok) return prepared
  const streamed = await streamReadTranscript(prepared, options)
  if (!streamed.ok) return streamed
  const bounded = options.tail && options.tail > 0
    ? boundItems(streamed.items, {
    tail: options.tail,
    maxItems: options.maxItems ?? DEFAULT_MAX_ITEMS,
    maxChars: options.maxChars ?? DEFAULT_MAX_CHARS,
    maxCharsPerItem: options.maxCharsPerItem ?? DEFAULT_MAX_CHARS_PER_ITEM,
      })
    : { items: streamed.items, truncated: streamed.truncated }

  return {
    ok: true,
    path: prepared.source.path,
    provider: prepared.provider,
    projection: options.projection,
    items: bounded.items,
    truncated: streamed.truncated || bounded.truncated,
    stats: {
      ...streamed.stats,
      returnedItems: bounded.items.length,
    },
  }
}

export async function inspectAgentTranscriptFile(
  options: InspectFileOptions,
  deps: AgentTranscriptReaderDeps = DEFAULT_DEPS,
): Promise<AgentTranscriptInspectResult | AgentTranscriptErrorResult> {
  const prepared = await prepareTranscript(options.path, options.provider ?? 'auto', deps)
  if (!prepared.ok) return prepared
  const parsed = await inspectTranscript(prepared)
  if (!parsed.ok) return parsed
  return {
    ok: true,
    path: prepared.source.path,
    provider: prepared.provider,
    firstTimestamp: parsed.firstTimestamp,
    lastTimestamp: parsed.lastTimestamp,
    stats: parsed.stats,
  }
}

export async function searchAgentTranscriptFile(
  options: SearchFileOptions,
  deps: AgentTranscriptReaderDeps = DEFAULT_DEPS,
): Promise<AgentTranscriptSearchResult | AgentTranscriptErrorResult> {
  const prepared = await prepareTranscript(options.path, options.provider ?? 'auto', deps)
  if (!prepared.ok) return prepared
  const searched = await streamSearchTranscript(prepared, options)
  if (!searched.ok) return searched

  return {
    ok: true,
    path: prepared.source.path,
    provider: prepared.provider,
    query: options.query,
    matches: searched.matches,
    truncated: searched.truncated,
    stats: {
      ...searched.stats,
      returnedItems: searched.matches.length,
    },
  }
}

// Resolve a path argument to a readable source and its provider, once, before
// any reducer runs. Location errors come before provider errors, so a caller
// with a bad path and a bad provider fixes the path first.
async function prepareTranscript(
  path: string,
  requestedProvider: AgentTranscriptProviderInput,
  deps: AgentTranscriptReaderDeps,
): Promise<PreparedTranscript | AgentTranscriptErrorResult> {
  if (!path.trim()) {
    return {
      ok: false,
      error: 'path_required',
      message: 'A transcript file path is required.',
    }
  }

  const opencodeSessionID = parseOpencodeTranscriptFile(path)
  if (opencodeSessionID) {
    let store: OpencodeStore
    try {
      store = await deps.opencode.store()
    } catch (err) {
      return {
        ok: false,
        error: 'file_not_readable',
        message: `OpenCode's database is not readable: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
    let exists: boolean
    try {
      exists = store.readSessionInfo(opencodeSessionID) !== null
    } catch (err) {
      return {
        ok: false,
        error: 'transcript_read_failed',
        message: err instanceof Error ? err.message : String(err),
      }
    }
    if (!exists) {
      return {
        ok: false,
        error: 'file_not_found',
        message: `OpenCode has no session ${opencodeSessionID}.`,
      }
    }
    if (requestedProvider !== 'auto' && requestedProvider !== 'opencode') {
      return {
        ok: false,
        error: 'unsupported_provider',
        message: `${path} is an OpenCode session, not a ${requestedProvider} transcript.`,
      }
    }
    return {
      ok: true,
      source: { kind: 'opencode', path, sessionID: opencodeSessionID, store },
      provider: 'opencode',
    }
  }

  try {
    await access(path, constants.R_OK)
  } catch {
    return {
      ok: false,
      error: 'file_not_readable',
      message: `Transcript file is missing or not readable: ${path}`,
    }
  }
  const source: TranscriptSource = { kind: 'jsonl', path }
  switch (requestedProvider) {
    case 'claude':
    case 'codex':
      return { ok: true, source, provider: requestedProvider }
    case 'opencode':
      return {
        ok: false,
        error: 'unsupported_provider',
        message: 'OpenCode sessions have no transcript file; pass their opencode://session/<id> locator.',
      }
    case 'auto': {
      const provider = await detectJsonlProvider(path)
      if (!provider) {
        return {
          ok: false,
          error: 'provider_detection_failed',
          message: 'Could not detect whether this transcript is Claude or Codex JSONL.',
        }
      }
      return { ok: true, source, provider }
    }
    default:
      return {
        ok: false,
        error: 'unsupported_provider',
        message: `Unsupported transcript provider: ${String(requestedProvider)}`,
      }
  }
}

async function* transcriptRecords(source: TranscriptSource): AsyncGenerator<JsonRecord | null> {
  switch (source.kind) {
    case 'jsonl':
      yield* streamJsonl<JsonRecord>(source.path)
      return
    case 'opencode':
      for (const record of source.store.iterateMessages(source.sessionID)) {
        yield record as unknown as JsonRecord
      }
      return
  }
}

// WHY exhaustive switches rather than `provider === 'claude' ? … : …`: the
// old two-way ternaries sent every non-Claude provider through the Codex
// extractor, so OpenCode records parsed as nothing at all without an error.
// A new provider kind now fails to compile here until it has an extractor.
function recordTimestamp(provider: AgentTranscriptProvider, raw: JsonRecord): number | undefined {
  switch (provider) {
    case 'claude':
    case 'codex':
      return extractTimestamp(raw)
    case 'opencode':
      return finiteNumber(asRecord(asRecord(raw.info)?.time)?.created)
  }
}

function extractItems(
  provider: AgentTranscriptProvider,
  raw: JsonRecord,
  timestamp: number | undefined,
): AgentTranscriptItem[] {
  switch (provider) {
    case 'claude':
      return extractClaudeItems(raw, timestamp)
    case 'codex':
      return extractCodexItems(raw, timestamp)
    case 'opencode':
      return extractOpencodeItems(raw, timestamp)
  }
}

async function streamReadTranscript(
  prepared: PreparedTranscript,
  options: ReadFileOptions,
): Promise<
  | {
      ok: true
      items: AgentTranscriptItem[]
      truncated: boolean
      stats: AgentTranscriptStats
    }
  | AgentTranscriptErrorResult
> {
  const stats = emptyStats()
  const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS
  const maxCharsPerItem = options.maxCharsPerItem ?? DEFAULT_MAX_CHARS_PER_ITEM
  const tail = options.tail && options.tail > 0 ? options.tail : 0
  const selected: AgentTranscriptItem[] = []
  let selectedChars = 0
  let truncated = false
  let previous: AgentTranscriptItem | null = null
  let sawFinalAssistant = false
  let lastAssistant: AgentTranscriptItem | null = null
  let lastSelectedAssistant: AgentTranscriptItem | null = null

  // WHY read/tail/final stream instead of materializing the transcript:
  // they are consumption tools, not archival parsers. Parent agents commonly
  // read large child transcripts with tiny caps. This reducer keeps full
  // stats while retaining only the projected window that can actually be
  // returned.
  try {
    for await (const raw of transcriptRecords(prepared.source)) {
      stats.totalEvents += 1
      if (raw === null) {
        stats.parseErrors += 1
        continue
      }
      const timestamp = recordTimestamp(prepared.provider, raw)
      for (const rawItem of extractItems(prepared.provider, raw, timestamp)) {
        const item = acceptDedupedItem(previous, rawItem)
        if (!item) continue
        previous = item
        incrementStats(stats, item)
        if (item.kind === 'assistant_message') {
          lastAssistant = item
          sawFinalAssistant = sawFinalAssistant || item.final === true
        }
        if (!itemMatchesProjection(item, options.projection, options.include)) continue
        const selectedItem = addProjectedReadItem(selected, item, {
          tail,
          maxItems,
          maxChars,
          maxCharsPerItem,
          selectedCharsRef: {
            get: () => selectedChars,
            set: next => { selectedChars = next },
          },
          markTruncated: () => { truncated = true },
        })
        if (selectedItem?.kind === 'assistant_message') lastSelectedAssistant = selectedItem
      }
    }
  } catch (err) {
    return {
      ok: false,
      error: 'transcript_read_failed',
      message: err instanceof Error ? err.message : String(err),
    }
  }

  if (!sawFinalAssistant && lastAssistant?.kind === 'assistant_message') {
    lastAssistant.final = true
    if (lastSelectedAssistant) lastSelectedAssistant.final = true
    // WHY the extra lastSelectedAssistant check: `selected` holds truncated
    // CLONES (truncateItemText always spreads), so `includes(lastAssistant)`
    // can never match by reference when the last assistant was selected via an
    // include override. Without this guard, projection:'final' plus
    // include.assistantMessages would append the same answer twice. If the
    // clone was later evicted by the tail ring, includes() is false and we
    // correctly re-add the final answer, same as before.
    const lastAssistantAlreadySelected =
      selected.includes(lastAssistant) ||
      (lastSelectedAssistant !== null && selected.includes(lastSelectedAssistant))
    if (options.projection === 'final' && !lastAssistantAlreadySelected) {
      addProjectedReadItem(selected, lastAssistant, {
        tail,
        maxItems,
        maxChars,
        maxCharsPerItem,
        selectedCharsRef: {
          get: () => selectedChars,
          set: next => { selectedChars = next },
        },
        markTruncated: () => { truncated = true },
      })
    }
  }

  return {
    ok: true,
    items: selected,
    truncated,
    stats,
  }
}

// WHY adjacent equivalent items collapse: a single visible Codex
// assistant/user message is commonly recorded twice, once as a high-level
// `event_msg` used by Agent Code's runtime feed and once as a canonical
// `response_item` from the provider rollout. Both are useful in raw
// transcript debugging, but this MCP domain is deliberately a consumption
// boundary for another agent's work product. Returning both makes searches
// look like duplicate findings and makes `contextItems` echo the same
// sentence before/after itself. Only ADJACENT equivalents collapse, and
// equivalence includes the timestamp, so distinct repeated messages survive
// when the transcript actually contains separate turns.
function acceptDedupedItem(
  previous: AgentTranscriptItem | null,
  item: AgentTranscriptItem,
): AgentTranscriptItem | null {
  if (previous && transcriptItemsEquivalent(previous, item)) {
    if (previous.kind === 'assistant_message' && item.kind === 'assistant_message') {
      previous.final = previous.final || item.final
    }
    return null
  }
  return { ...item }
}

function itemMatchesProjection(
  item: AgentTranscriptItem,
  projection: AgentTranscriptProjection,
  include: AgentTranscriptIncludeOptions | undefined,
): boolean {
  if (isRawToolOutputItem(item) && include?.rawToolOutputs !== true) return false
  if (include && includeOverride(item, include) === true) return true
  if (include && includeOverride(item, include) === false) return false
  if (projection === 'final') return item.kind === 'assistant_message' && item.final === true
  return projectionKinds(projection).has(item.kind)
}

function addProjectedReadItem(
  selected: AgentTranscriptItem[],
  item: AgentTranscriptItem,
  options: {
    tail: number
    maxItems: number
    maxChars: number
    maxCharsPerItem: number
    selectedCharsRef: { get: () => number; set: (value: number) => void }
    markTruncated: () => void
  },
): AgentTranscriptItem | null {
  if (options.tail > 0) {
    // Truncate BEFORE the ring, not only in the boundItems final pass (#373).
    // tail can be as large as 10_000 (schema max), and this ring used to hold
    // RAW items while streaming: a transcript full of megabyte tool dumps
    // meant the reader retained tail x raw-item bytes in memory even though
    // boundItems would throw almost all of it away afterwards. Per-item
    // truncation is idempotent, so boundItems re-running it on these items is
    // a no-op; boundItems remains the final authority for maxItems/maxChars.
    // Text truncation deliberately does NOT markTruncated() here — matching
    // boundItems, where only dropped ITEMS flip the result-level flag.
    const bounded = truncateItemText(item, options.maxCharsPerItem)
    selected.push(bounded)
    while (selected.length > options.tail) {
      selected.shift()
      options.markTruncated()
    }
    // Return the ring object (not the raw item): the caller tracks the
    // returned reference as lastSelectedAssistant and later mutates
    // `.final = true` on it, which must reach the copy actually in the ring.
    return bounded
  }

  const bounded = truncateItemText(item, options.maxCharsPerItem)
  const size = itemSearchText(bounded).length
  if (selected.length >= options.maxItems || options.selectedCharsRef.get() + size > options.maxChars) {
    options.markTruncated()
    return null
  }
  options.selectedCharsRef.set(options.selectedCharsRef.get() + size)
  selected.push(bounded)
  return bounded
}

async function streamSearchTranscript(
  prepared: PreparedTranscript,
  options: SearchFileOptions,
): Promise<
  | {
      ok: true
      matches: AgentTranscriptSearchResult['matches']
      truncated: boolean
      stats: AgentTranscriptStats
    }
  | AgentTranscriptErrorResult
> {
  const stats = emptyStats()
  const query = options.query.toLowerCase()
  const kinds = options.kinds?.length ? new Set(options.kinds) : null
  const contextItems = options.contextItems ?? DEFAULT_SEARCH_CONTEXT_ITEMS
  const maxMatches = options.maxMatches ?? DEFAULT_SEARCH_MATCHES
  const maxCharsPerMatch = options.maxCharsPerMatch ?? DEFAULT_SEARCH_CHARS_PER_MATCH
  const matches: AgentTranscriptSearchResult['matches'] = []
  const beforeRing: AgentTranscriptItem[] = []
  const pendingAfter: Array<{ match: AgentTranscriptSearchResult['matches'][number]; remaining: number }> = []
  let previous: AgentTranscriptItem | null = null
  let truncated = false

  try {
    for await (const raw of transcriptRecords(prepared.source)) {
      stats.totalEvents += 1
      if (raw === null) {
        stats.parseErrors += 1
        continue
      }
      const timestamp = recordTimestamp(prepared.provider, raw)
      for (const rawItem of extractItems(prepared.provider, raw, timestamp)) {
        const item = acceptDedupedItem(previous, rawItem)
        if (!item) continue
        previous = item
        incrementStats(stats, item)

        if (!isRawToolOutputItem(item)) {
          for (const pending of pendingAfter) {
            if (pending.remaining <= 0) continue
            const next = truncateItemText(item, maxCharsPerMatch)
            pending.match.after = [...(pending.match.after ?? []), next]
            pending.remaining -= 1
          }
        }

        const matchesKind = !kinds || kinds.has(item.kind)
        const searchText = !isRawToolOutputItem(item) && matchesKind
          ? itemSearchText(item).toLowerCase()
          : ''
        if (searchText && searchText.includes(query)) {
          if (matches.length >= maxMatches) {
            truncated = true
          } else {
            const match = {
              item: truncateItemText(item, maxCharsPerMatch),
              before: contextItems > 0
                ? beforeRing.map(item => truncateItemText(item, maxCharsPerMatch))
                : undefined,
              after: contextItems > 0 ? [] : undefined,
            }
            matches.push(match)
            if (contextItems > 0) pendingAfter.push({ match, remaining: contextItems })
          }
        }

        if (!isRawToolOutputItem(item) && contextItems > 0) {
          beforeRing.push(item)
          while (beforeRing.length > contextItems) beforeRing.shift()
        }
      }
    }
  } catch (err) {
    return {
      ok: false,
      error: 'transcript_read_failed',
      message: err instanceof Error ? err.message : String(err),
    }
  }

  for (const match of matches) {
    if (match.after && match.after.length === 0) delete match.after
  }

  return {
    ok: true,
    matches,
    truncated,
    stats,
  }
}

async function inspectTranscript(
  prepared: PreparedTranscript,
): Promise<
  | {
      ok: true
      stats: AgentTranscriptStats
      firstTimestamp?: number
      lastTimestamp?: number
    }
  | AgentTranscriptErrorResult
> {
  const stats = emptyStats()
  let firstTimestamp: number | undefined
  let lastTimestamp: number | undefined
  let previous: AgentTranscriptItem | null = null

  // WHY inspect has its own reducer: it only needs provider, timestamps, and
  // counts. Agent review workflows often inspect large child-agent
  // transcripts before deciding what to read; this reducer keeps that sizing
  // step O(1) heap while preserving the same adjacent-dedupe semantics used by
  // read/search.
  try {
    for await (const raw of transcriptRecords(prepared.source)) {
      stats.totalEvents += 1
      if (raw === null) {
        stats.parseErrors += 1
        continue
      }
      const timestamp = recordTimestamp(prepared.provider, raw)
      if (timestamp !== undefined) {
        firstTimestamp = firstTimestamp === undefined ? timestamp : Math.min(firstTimestamp, timestamp)
        lastTimestamp = lastTimestamp === undefined ? timestamp : Math.max(lastTimestamp, timestamp)
      }
      for (const item of extractItems(prepared.provider, raw, timestamp)) {
        if (previous && transcriptItemsEquivalent(previous, item)) {
          if (previous.kind === 'assistant_message' && item.kind === 'assistant_message') {
            previous.final = previous.final || item.final
          }
          continue
        }
        previous = { ...item }
        incrementStats(stats, previous)
      }
    }
  } catch (err) {
    return {
      ok: false,
      error: 'transcript_read_failed',
      message: err instanceof Error ? err.message : String(err),
    }
  }

  return {
    ok: true,
    stats,
    firstTimestamp,
    lastTimestamp,
  }
}

async function detectJsonlProvider(path: string): Promise<'claude' | 'codex' | null> {
  for await (const raw of streamJsonl<JsonRecord>(path)) {
    if (raw === null) continue
    const type = stringField(raw, 'type')
    const payload = asRecord(raw.payload)
    if (type === 'response_item' || type === 'event_msg' || type === 'turn_context') return 'codex'
    if (
      (type === 'user' || type === 'assistant') &&
      asRecord(raw.message) &&
      (raw.sessionId !== undefined || raw.uuid !== undefined || raw.cwd !== undefined)
    ) {
      return 'claude'
    }
    if (payload && (payload.type === 'agent_message' || payload.type === 'user_message')) return 'codex'
  }
  return null
}

function extractClaudeItems(raw: JsonRecord, timestamp: number | undefined): AgentTranscriptItem[] {
  const type = stringField(raw, 'type')
  const message = asRecord(raw.message)
  const role = stringField(message, 'role') || type
  if (!message) return []
  if (role === 'user') {
    const text = flattenTextContent(message.content, ['text'])
    return text ? [{ kind: 'user_message', timestamp, text }] : []
  }
  if (role === 'assistant') {
    const content = Array.isArray(message.content) ? message.content : []
    const items: AgentTranscriptItem[] = []
    const text = flattenTextContent(content, ['text'])
    if (text) items.push({ kind: 'assistant_message', timestamp, text })
    for (const block of content) {
      const tool = extractClaudeToolUse(asRecord(block), timestamp)
      if (tool) items.push(tool)
    }
    return items
  }
  return []
}

function extractCodexItems(raw: JsonRecord, timestamp: number | undefined): AgentTranscriptItem[] {
  const type = stringField(raw, 'type')
  const payload = asRecord(raw.payload)
  if (type === 'response_item') {
    const item = payload ?? raw
    return extractCodexResponseItem(item, timestamp, stringField(item, 'phase'))
  }
  if (type === 'event_msg') {
    const msgType = stringField(payload, 'type')
    if (msgType === 'user_message') {
      const text = stringField(payload, 'message')
      return text ? [{ kind: 'user_message', timestamp, text }] : []
    }
    if (msgType === 'agent_message') {
      const text = stringField(payload, 'message')
      const phase = stringField(payload, 'phase')
      return text ? [{ kind: 'assistant_message', timestamp, text, final: phase === 'final_answer' }] : []
    }
  }
  if (type === 'message' || type === 'function_call' || type === 'function_call_output') {
    return extractCodexResponseItem(raw, timestamp, stringField(raw, 'phase'))
  }
  return []
}

function extractCodexResponseItem(
  item: JsonRecord,
  timestamp: number | undefined,
  phase: string | undefined,
): AgentTranscriptItem[] {
  const itemType = stringField(item, 'type')
  if (itemType === 'message') {
    const role = stringField(item, 'role')
    const text = flattenTextContent(item.content, ['input_text', 'output_text', 'text'])
    if (!text) return []
    if (role === 'user') return [{ kind: 'user_message', timestamp, text }]
    if (role === 'assistant') return [{ kind: 'assistant_message', timestamp, text, final: phase === 'final_answer' }]
    return []
  }

  if (itemType === 'function_call') {
    const name = stringField(item, 'name') ?? 'function_call'
    const args = parseMaybeJsonObject(stringField(item, 'arguments'))
    return [classifyToolCall(name, args, timestamp)]
  }

  if (itemType === 'function_call_output') {
    const output = stringField(item, 'output')
    if (!output) return []
    return [{
      kind: 'tool_read',
      timestamp,
      tool: RAW_TOOL_OUTPUT,
      excerpt: output,
    }]
  }

  return []
}

// OpenCode records are whole messages, `{ info, parts }`, exactly as
// OpenCode's database holds them (see TranscriptSource).
//
// What counts as the conversation mirrors OpenCode's own TUI and Agent Code's
// OpenCode feed mapper:
// - Text parts marked `synthetic` or `ignored` are OpenCode's insertions
//   (plan-mode instructions, "Summarize the task tool output above…", MCP
//   resource notices), not words the user or the model wrote.
// - Reasoning parts are dropped, as the Claude and Codex extractors drop
//   thinking blocks: this domain returns an agent's work product.
// - An assistant message counts once OpenCode stamps `time.completed`. Until
//   then its parts are still streaming, and a read would return half a
//   sentence. OpenCode starts a new assistant message for every step, so
//   only the step in flight is left out.
function extractOpencodeItems(raw: JsonRecord, timestamp: number | undefined): AgentTranscriptItem[] {
  const info = asRecord(raw.info)
  const role = stringField(info, 'role')
  const parts = recordArray(raw.parts)
  if (role === 'user') {
    const text = opencodeMessageText(parts)
    return text ? [{ kind: 'user_message', timestamp, text }] : []
  }
  if (role !== 'assistant') return []
  if (finiteNumber(asRecord(info?.time)?.completed) === undefined) return []

  const items: AgentTranscriptItem[] = []
  const text = opencodeMessageText(parts)
  if (text) {
    // `finish` is the model's stop reason. 'tool-calls' means the step ended
    // to run tools and the turn continues; any other reason ('stop',
    // 'length', …) ends the turn, so that step's text is the answer.
    const finish = stringField(info, 'finish')
    items.push({ kind: 'assistant_message', timestamp, text, final: finish !== undefined && finish !== 'tool-calls' })
  }
  for (const part of parts) {
    const type = stringField(part, 'type')
    if (type === 'tool') {
      items.push(...extractOpencodeToolPart(part, timestamp))
    } else if (type === 'patch') {
      // The step's snapshot diff: every file the step changed, however it
      // changed it. This is the only record of files written by shell
      // commands (formatters, codegen, `sed -i`), which no tool call names.
      const files = stringArray(part.files)
      if (files.length > 0) {
        items.push({ kind: 'patch', timestamp, files, summary: `${files.length} file${files.length === 1 ? '' : 's'} changed in this step` })
      }
    }
  }
  return items
}

function opencodeMessageText(parts: JsonRecord[]): string {
  return parts
    .filter(part => part.type === 'text' && part.synthetic !== true && part.ignored !== true)
    .flatMap(part => stringField(part, 'text') ?? [])
    .join('\n')
    .trim()
}

function extractOpencodeToolPart(part: JsonRecord, messageTimestamp: number | undefined): AgentTranscriptItem[] {
  const tool = stringField(part, 'tool') ?? 'tool'
  const state = asRecord(part.state)
  const input = asRecord(state?.input)
  const metadata = asRecord(state?.metadata)
  const time = asRecord(state?.time)
  // WHY each tool call carries its own start time rather than its message's:
  // one OpenCode step often runs several tools, and adjacent-dedupe treats
  // equal text at an equal timestamp as one item. Two identical `ls` calls
  // in one step are two calls.
  const startedAt = finiteNumber(time?.start) ?? messageTimestamp
  const items: AgentTranscriptItem[] = [classifyOpencodeToolCall(tool, input, metadata, startedAt)]
  const output = stringField(state, 'output') ?? stringField(state, 'error')
  if (output) {
    items.push({ kind: 'tool_read', timestamp: finiteNumber(time?.end) ?? startedAt, tool: RAW_TOOL_OUTPUT, excerpt: output })
  }
  return items
}

// OpenCode's tool ids (vendor/in_progress/opencode/.../src/tool). Classified
// by id instead of through `classifyToolCall`, whose substring rules were
// written for Claude and Codex names: `todowrite` contains "write" and would
// be reported as a file write, when all it writes is the session's todo list.
function classifyOpencodeToolCall(
  tool: string,
  input: JsonRecord | undefined,
  metadata: JsonRecord | undefined,
  timestamp: number | undefined,
): AgentTranscriptItem {
  switch (tool) {
    case 'bash': {
      // One id for every shell OpenCode drives (bash, pwsh, cmd).
      const item: AgentTranscriptItem = { kind: 'shell_command', timestamp, command: stringField(input, 'command') ?? '' }
      const cwd = stringField(input, 'workdir')
      if (cwd) item.cwd = cwd
      const exitCode = finiteNumber(metadata?.exit)
      if (exitCode !== undefined) item.exitCode = exitCode
      return item
    }
    case 'write':
    case 'edit': {
      const target = stringField(input, 'filePath')
      return { kind: 'tool_write', timestamp, tool, target, summary: target ? `${tool}: ${target}` : tool }
    }
    case 'apply_patch': {
      const files = applyPatchFiles(input, metadata)
      return { kind: 'patch', timestamp, files, summary: files.length > 0 ? `apply_patch: ${files.join(', ')}` : 'apply_patch' }
    }
    default: {
      const target = opencodeToolTarget(input)
      return { kind: 'tool_read', timestamp, tool, target, excerpt: target ? `${tool}: ${target}` : undefined }
    }
  }
}

// Files an apply_patch call touched. OpenCode reports them in the result's
// metadata once the patch applied; a call that failed before that still
// names them in its patch text.
function applyPatchFiles(input: JsonRecord | undefined, metadata: JsonRecord | undefined): string[] {
  const reported = recordArray(metadata?.files)
  if (reported.length > 0) {
    return reported.flatMap(file => [stringField(file, 'filePath'), stringField(file, 'movePath')].filter((path): path is string => path !== undefined))
  }
  const patchText = stringField(input, 'patchText') ?? ''
  const files: string[] = []
  for (const line of patchText.split(/\r?\n/)) {
    const match = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/.exec(line.trim())
    if (match?.[1]) files.push(match[1].trim())
  }
  return files
}

function opencodeToolTarget(input: JsonRecord | undefined): string | undefined {
  if (!input) return undefined
  for (const key of ['filePath', 'path', 'pattern', 'url', 'query', 'description', 'name']) {
    const value = stringField(input, key)
    if (value) return value
  }
  return undefined
}

function extractClaudeToolUse(
  block: JsonRecord | null | undefined,
  timestamp: number | undefined,
): AgentTranscriptItem | null {
  if (!block || block.type !== 'tool_use') return null
  const name = stringField(block, 'name') ?? 'tool_use'
  const input = asRecord(block.input)
  return classifyToolCall(name, input, timestamp)
}

function classifyToolCall(
  name: string,
  input: JsonRecord | null | undefined,
  timestamp: number | undefined,
): AgentTranscriptItem {
  const target = toolTarget(input)
  const recordInput = input ?? undefined
  const command = stringField(recordInput, 'cmd') ?? stringField(recordInput, 'command')
  if (name === 'exec_command' || name === 'Bash' || command) {
    const text = command ?? target ?? ''
    const shellItem: AgentTranscriptItem = {
      kind: 'shell_command',
      timestamp,
      command: text,
    }
    const cwd = stringField(recordInput, 'workdir') ?? stringField(recordInput, 'cwd')
    if (cwd) shellItem.cwd = cwd
    return shellItem
  }
  if (isWriteTool(name)) {
    return {
      kind: 'tool_write',
      timestamp,
      tool: name,
      target,
      summary: target ? `${name}: ${target}` : name,
    }
  }
  return {
    kind: 'tool_read',
    timestamp,
    tool: name,
    target,
    excerpt: target ? `${name}: ${target}` : undefined,
  }
}

function isWriteTool(name: string): boolean {
  return (
    name === 'apply_patch' ||
    name === 'Write' ||
    name === 'Edit' ||
    name === 'MultiEdit' ||
    name === 'create_draft' ||
    name === 'send_email' ||
    name.includes('write') ||
    name.includes('edit') ||
    name.includes('delete') ||
    name.includes('archive') ||
    name.includes('send')
  )
}

function toolTarget(input: JsonRecord | null | undefined): string | undefined {
  if (!input) return undefined
  for (const key of ['path', 'file_path', 'filename', 'workdir', 'cwd', 'query', 'pattern']) {
    const value = stringField(input, key)
    if (value) return value
  }
  return undefined
}

function isRawToolOutputItem(item: AgentTranscriptItem): boolean {
  return item.kind === 'tool_read' && item.tool === RAW_TOOL_OUTPUT
}

function projectionKinds(projection: AgentTranscriptProjection): Set<AgentTranscriptItemKind> {
  switch (projection) {
    case 'final':
      return new Set(['assistant_message'])
    case 'assistant_messages':
      return new Set(['assistant_message'])
    case 'conversation':
      return new Set(['user_message', 'assistant_message'])
    case 'tool_reads':
      return new Set(['tool_read'])
    case 'tool_writes':
    case 'file_changes':
      return new Set(['tool_write', 'patch'])
    case 'shell_commands':
      return new Set(['shell_command'])
    case 'tests':
      return new Set(['test_run', 'shell_command'])
    case 'timeline':
    case 'handoff':
      return new Set([
        'user_message',
        'assistant_message',
        'tool_read',
        'tool_write',
        'shell_command',
        'patch',
        'test_run',
      ])
  }
}

function includeOverride(
  item: AgentTranscriptItem,
  include: AgentTranscriptIncludeOptions,
): boolean | null {
  const flag = (() => {
    switch (item.kind) {
      case 'user_message':
        return include.userMessages
      case 'assistant_message':
        return include.assistantMessages
      case 'tool_read':
        return include.toolReads
      case 'tool_write':
        return include.toolWrites
      case 'shell_command':
        return include.shellCommands
      case 'patch':
        return include.patches
      case 'test_run':
        return include.testRuns
    }
  })()
  return flag === undefined ? null : flag
}

function boundItems(
  items: AgentTranscriptItem[],
  options: {
    tail?: number
    maxItems: number
    maxChars: number
    maxCharsPerItem: number
  },
): { items: AgentTranscriptItem[]; truncated: boolean } {
  let selected = options.tail && options.tail > 0 ? items.slice(-options.tail) : [...items]
  let truncated = selected.length !== items.length
  if (selected.length > options.maxItems) {
    selected = selected.slice(0, options.maxItems)
    truncated = true
  }

  const bounded: AgentTranscriptItem[] = []
  let usedChars = 0
  for (const item of selected) {
    const next = truncateItemText(item, options.maxCharsPerItem)
    const size = itemSearchText(next).length
    if (usedChars + size > options.maxChars) {
      truncated = true
      break
    }
    usedChars += size
    bounded.push(next)
  }
  return { items: bounded, truncated }
}

function truncateItemText(item: AgentTranscriptItem, maxChars: number): AgentTranscriptItem {
  const truncate = (text: string | undefined): string | undefined => {
    if (!text || text.length <= maxChars) return text
    return `${text.slice(0, Math.max(0, maxChars - 24))}\n[truncated]`
  }
  switch (item.kind) {
    case 'user_message':
    case 'assistant_message':
      return { ...item, text: truncate(item.text) ?? '' }
    case 'tool_read':
      return { ...item, excerpt: truncate(item.excerpt) }
    case 'tool_write':
      return { ...item, summary: truncate(item.summary) }
    case 'shell_command':
      return { ...item, command: truncate(item.command) ?? '', outputExcerpt: truncate(item.outputExcerpt) }
    case 'patch':
      return { ...item, summary: truncate(item.summary) }
    case 'test_run':
      return { ...item, command: truncate(item.command) ?? '', outputExcerpt: truncate(item.outputExcerpt) }
  }
}

function itemSearchText(item: AgentTranscriptItem): string {
  switch (item.kind) {
    case 'user_message':
    case 'assistant_message':
      return item.text
    case 'tool_read':
      return [item.tool, item.target, item.excerpt].filter(Boolean).join('\n')
    case 'tool_write':
      return [item.tool, item.target, item.summary].filter(Boolean).join('\n')
    case 'shell_command':
      return [item.cwd, item.command, item.outputExcerpt].filter(Boolean).join('\n')
    case 'patch':
      return [...item.files, item.summary].filter(Boolean).join('\n')
    case 'test_run':
      return [item.command, item.result, item.outputExcerpt].filter(Boolean).join('\n')
  }
}

function flattenTextContent(content: unknown, textTypes: string[]): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    const obj = asRecord(block)
    if (!obj) continue
    const type = stringField(obj, 'type')
    const text = stringField(obj, 'text')
    if (type && textTypes.includes(type) && text) parts.push(text)
  }
  return parts.join('\n').trim()
}

function extractTimestamp(raw: JsonRecord): number | undefined {
  const payload = asRecord(raw.payload)
  const candidates = [
    raw.timestamp,
    raw.ts,
    payload?.timestamp,
    payload?.ts,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate
    if (typeof candidate === 'string') {
      const parsed = Date.parse(candidate)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return undefined
}

function parseMaybeJsonObject(value: string | undefined): JsonRecord | undefined {
  return parseJsonRecord(value) ?? undefined
}

// Delegates to the shared "object but not array, not null" guard so the
// predicate has one source of truth. This reader's call sites rely on an
// `undefined` (not `null`) absence value, so we adapt with `?? undefined`
// rather than changing the shared semantics. See @shared/lib/asRecord.
function asRecord(value: unknown): JsonRecord | undefined {
  return asSharedRecord(value) ?? undefined
}

function stringField(record: JsonRecord | undefined, key: string): string | undefined {
  const value = record?.[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function recordArray(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) return []
  const records: JsonRecord[] = []
  for (const item of value) {
    const record = asRecord(item)
    if (record) records.push(record)
  }
  return records
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : []
}

function emptyStats(): AgentTranscriptStats {
  return {
    totalEvents: 0,
    returnedItems: 0,
    userMessages: 0,
    assistantMessages: 0,
    toolReads: 0,
    toolWrites: 0,
    shellCommands: 0,
    patches: 0,
    testRuns: 0,
    parseErrors: 0,
  }
}

function transcriptItemsEquivalent(left: AgentTranscriptItem, right: AgentTranscriptItem): boolean {
  if (left.kind !== right.kind) return false
  if (left.timestamp !== right.timestamp) return false
  return itemSearchText(left) === itemSearchText(right)
}

function incrementStats(stats: AgentTranscriptStats, item: AgentTranscriptItem): void {
  switch (item.kind) {
    case 'user_message':
      stats.userMessages += 1
      return
    case 'assistant_message':
      stats.assistantMessages += 1
      return
    case 'tool_read':
      stats.toolReads += 1
      return
    case 'tool_write':
      stats.toolWrites += 1
      return
    case 'shell_command':
      stats.shellCommands += 1
      return
    case 'patch':
      stats.patches += 1
      return
    case 'test_run':
      stats.testRuns += 1
      return
  }
}
