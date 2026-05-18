import { access } from 'node:fs/promises'
import { constants } from 'node:fs'

import { streamJsonl } from '@shared/runtime/streamJsonl.js'
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

type JsonRecord = Record<string, unknown>

type ParsedTranscript = {
  ok: true
  provider: AgentTranscriptProvider
  path: string
  items: AgentTranscriptItem[]
  stats: AgentTranscriptStats
  firstTimestamp?: number
  lastTimestamp?: number
}

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

const DEFAULT_MAX_ITEMS = 100
const DEFAULT_MAX_CHARS = 24_000
const DEFAULT_MAX_CHARS_PER_ITEM = 4_000
const DEFAULT_SEARCH_MATCHES = 25
const DEFAULT_SEARCH_CONTEXT_ITEMS = 1
const DEFAULT_SEARCH_CHARS_PER_MATCH = 2_000

export async function readAgentTranscriptFile(
  options: ReadFileOptions,
): Promise<AgentTranscriptReadResult | AgentTranscriptErrorResult> {
  const prepared = await preparePath(options.path)
  if (!prepared.ok) return prepared
  const streamed = await streamReadTranscript(prepared.path, options)
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
    path: prepared.path,
    provider: streamed.provider,
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
): Promise<AgentTranscriptInspectResult | AgentTranscriptErrorResult> {
  const prepared = await preparePath(options.path)
  if (!prepared.ok) return prepared
  const parsed = await inspectTranscript(prepared.path, options.provider ?? 'auto')
  if (!parsed.ok) return parsed
  return {
    ok: true,
    path: prepared.path,
    provider: parsed.provider,
    firstTimestamp: parsed.firstTimestamp,
    lastTimestamp: parsed.lastTimestamp,
    stats: parsed.stats,
  }
}

export async function searchAgentTranscriptFile(
  options: SearchFileOptions,
): Promise<AgentTranscriptSearchResult | AgentTranscriptErrorResult> {
  const prepared = await preparePath(options.path)
  if (!prepared.ok) return prepared
  const searched = await streamSearchTranscript(prepared.path, options)
  if (!searched.ok) return searched

  return {
    ok: true,
    path: prepared.path,
    provider: searched.provider,
    query: options.query,
    matches: searched.matches,
    truncated: searched.truncated,
    stats: {
      ...searched.stats,
      returnedItems: searched.matches.length,
    },
  }
}

async function preparePath(path: string): Promise<
  | { ok: true; path: string }
  | AgentTranscriptErrorResult
> {
  if (!path.trim()) {
    return {
      ok: false,
      error: 'path_required',
      message: 'A transcript file path is required.',
    }
  }
  try {
    await access(path, constants.R_OK)
    return { ok: true, path }
  } catch {
    return {
      ok: false,
      error: 'file_not_readable',
      message: `Transcript file is missing or not readable: ${path}`,
    }
  }
}

async function resolveProvider(
  path: string,
  requestedProvider: AgentTranscriptProviderInput,
): Promise<
  | { ok: true; provider: AgentTranscriptProvider }
  | AgentTranscriptErrorResult
> {
  if (requestedProvider !== 'auto' && requestedProvider !== 'claude' && requestedProvider !== 'codex') {
    return {
      ok: false,
      error: 'unsupported_provider',
      message: `Unsupported transcript provider: ${requestedProvider}`,
    }
  }
  const provider = requestedProvider === 'auto'
    ? await detectProvider(path)
    : requestedProvider
  if (!provider) {
    return {
      ok: false,
      error: 'provider_detection_failed',
      message: 'Could not detect whether this transcript is Claude or Codex JSONL.',
    }
  }
  return { ok: true, provider }
}

async function streamReadTranscript(
  path: string,
  options: ReadFileOptions,
): Promise<
  | {
      ok: true
      provider: AgentTranscriptProvider
      items: AgentTranscriptItem[]
      truncated: boolean
      stats: AgentTranscriptStats
    }
  | AgentTranscriptErrorResult
> {
  const resolved = await resolveProvider(path, options.provider ?? 'auto')
  if (!resolved.ok) return resolved

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

  // WHY this is separate from parseTranscript:
  // read/tail/final are consumption tools, not archival parsers. The old
  // path streamed JSONL from disk but then retained every normalized item,
  // copied them again for adjacent-dedupe, and only then applied maxItems,
  // maxChars, tail, and projection. Parent agents commonly read large child
  // transcripts with tiny caps. This reducer preserves full stats while
  // retaining only the projected window that can actually be returned.
  try {
    for await (const raw of streamJsonl<JsonRecord>(path)) {
      stats.totalEvents += 1
      if (raw === null) {
        stats.parseErrors += 1
        continue
      }
      const timestamp = extractTimestamp(raw)
      const extracted = resolved.provider === 'claude'
        ? extractClaudeItems(raw, timestamp)
        : extractCodexItems(raw, timestamp)
      for (const rawItem of extracted) {
        const item = acceptDedupedItem(previous, rawItem)
        if (!item) continue
        previous = item
        incrementStats(stats, item)
        if (item.kind === 'assistant_message') {
          lastAssistant = item
          sawFinalAssistant = sawFinalAssistant || item.final === true
        }
        if (!itemMatchesProjection(item, options.projection, options.include)) continue
        addProjectedReadItem(selected, item, {
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
  } catch (err) {
    return {
      ok: false,
      error: 'transcript_read_failed',
      message: err instanceof Error ? err.message : String(err),
    }
  }

  if (!sawFinalAssistant && lastAssistant?.kind === 'assistant_message') {
    lastAssistant.final = true
    if (options.projection === 'final' && !selected.includes(lastAssistant)) {
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
    provider: resolved.provider,
    items: selected,
    truncated,
    stats,
  }
}

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
): void {
  if (options.tail > 0) {
    selected.push(item)
    while (selected.length > options.tail) {
      selected.shift()
      options.markTruncated()
    }
    return
  }

  const bounded = truncateItemText(item, options.maxCharsPerItem)
  const size = itemSearchText(bounded).length
  if (selected.length >= options.maxItems || options.selectedCharsRef.get() + size > options.maxChars) {
    options.markTruncated()
    return
  }
  options.selectedCharsRef.set(options.selectedCharsRef.get() + size)
  selected.push(bounded)
}

async function streamSearchTranscript(
  path: string,
  options: SearchFileOptions,
): Promise<
  | {
      ok: true
      provider: AgentTranscriptProvider
      matches: AgentTranscriptSearchResult['matches']
      truncated: boolean
      stats: AgentTranscriptStats
    }
  | AgentTranscriptErrorResult
> {
  const resolved = await resolveProvider(path, options.provider ?? 'auto')
  if (!resolved.ok) return resolved

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
    for await (const raw of streamJsonl<JsonRecord>(path)) {
      stats.totalEvents += 1
      if (raw === null) {
        stats.parseErrors += 1
        continue
      }
      const timestamp = extractTimestamp(raw)
      const extracted = resolved.provider === 'claude'
        ? extractClaudeItems(raw, timestamp)
        : extractCodexItems(raw, timestamp)
      for (const rawItem of extracted) {
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
    provider: resolved.provider,
    matches,
    truncated,
    stats,
  }
}

async function parseTranscript(
  path: string,
  requestedProvider: AgentTranscriptProviderInput,
): Promise<ParsedTranscript | AgentTranscriptErrorResult> {
  if (requestedProvider !== 'auto' && requestedProvider !== 'claude' && requestedProvider !== 'codex') {
    return {
      ok: false,
      error: 'unsupported_provider',
      message: `Unsupported transcript provider: ${requestedProvider}`,
    }
  }
  const provider = requestedProvider === 'auto'
    ? await detectProvider(path)
    : requestedProvider
  if (!provider) {
    return {
      ok: false,
      error: 'provider_detection_failed',
      message: 'Could not detect whether this transcript is Claude or Codex JSONL.',
    }
  }

  const rawItems: AgentTranscriptItem[] = []
  const stats = emptyStats()
  let firstTimestamp: number | undefined
  let lastTimestamp: number | undefined

  try {
    for await (const raw of streamJsonl<JsonRecord>(path)) {
      stats.totalEvents += 1
      if (raw === null) {
        stats.parseErrors += 1
        continue
      }
      const timestamp = extractTimestamp(raw)
      if (timestamp !== undefined) {
        firstTimestamp = firstTimestamp === undefined ? timestamp : Math.min(firstTimestamp, timestamp)
        lastTimestamp = lastTimestamp === undefined ? timestamp : Math.max(lastTimestamp, timestamp)
      }
      const extracted = provider === 'claude'
        ? extractClaudeItems(raw, timestamp)
        : extractCodexItems(raw, timestamp)
      for (const item of extracted) {
        rawItems.push(item)
      }
    }
  } catch (err) {
    return {
      ok: false,
      error: 'transcript_read_failed',
      message: err instanceof Error ? err.message : String(err),
    }
  }

  const items = dedupeAdjacentTranscriptItems(rawItems)
  for (const item of items) {
    incrementStats(stats, item)
  }
  markFallbackFinal(items)

  return {
    ok: true,
    provider,
    path,
    items,
    stats,
    firstTimestamp,
    lastTimestamp,
  }
}

async function inspectTranscript(
  path: string,
  requestedProvider: AgentTranscriptProviderInput,
): Promise<
  | {
      ok: true
      provider: AgentTranscriptProvider
      stats: AgentTranscriptStats
      firstTimestamp?: number
      lastTimestamp?: number
    }
  | AgentTranscriptErrorResult
> {
  if (requestedProvider !== 'auto' && requestedProvider !== 'claude' && requestedProvider !== 'codex') {
    return {
      ok: false,
      error: 'unsupported_provider',
      message: `Unsupported transcript provider: ${requestedProvider}`,
    }
  }
  const provider = requestedProvider === 'auto'
    ? await detectProvider(path)
    : requestedProvider
  if (!provider) {
    return {
      ok: false,
      error: 'provider_detection_failed',
      message: 'Could not detect whether this transcript is Claude or Codex JSONL.',
    }
  }

  const stats = emptyStats()
  let firstTimestamp: number | undefined
  let lastTimestamp: number | undefined
  let previous: AgentTranscriptItem | null = null

  // WHY inspect has its own reducer instead of calling parseTranscript:
  // inspect only needs provider, timestamps, and counts, but parseTranscript
  // materializes every normalized item, copies them again during dedupe, and
  // only then counts. Agent review workflows often inspect large child-agent
  // transcripts before deciding what to read; this reducer keeps that sizing
  // step O(1) heap while preserving the same adjacent-dedupe semantics used by
  // read/search.
  try {
    for await (const raw of streamJsonl<JsonRecord>(path)) {
      stats.totalEvents += 1
      if (raw === null) {
        stats.parseErrors += 1
        continue
      }
      const timestamp = extractTimestamp(raw)
      if (timestamp !== undefined) {
        firstTimestamp = firstTimestamp === undefined ? timestamp : Math.min(firstTimestamp, timestamp)
        lastTimestamp = lastTimestamp === undefined ? timestamp : Math.max(lastTimestamp, timestamp)
      }
      const extracted = provider === 'claude'
        ? extractClaudeItems(raw, timestamp)
        : extractCodexItems(raw, timestamp)
      for (const item of extracted) {
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
    provider,
    stats,
    firstTimestamp,
    lastTimestamp,
  }
}

async function detectProvider(path: string): Promise<AgentTranscriptProvider | null> {
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
      tool: 'function_call_output',
      excerpt: output,
    }]
  }

  return []
}

function extractClaudeToolUse(
  block: JsonRecord | undefined,
  timestamp: number | undefined,
): AgentTranscriptItem | null {
  if (!block || block.type !== 'tool_use') return null
  const name = stringField(block, 'name') ?? 'tool_use'
  const input = asRecord(block.input)
  return classifyToolCall(name, input, timestamp)
}

function classifyToolCall(
  name: string,
  input: JsonRecord | undefined,
  timestamp: number | undefined,
): AgentTranscriptItem {
  const target = toolTarget(input)
  const command = stringField(input, 'cmd') ?? stringField(input, 'command')
  if (name === 'exec_command' || name === 'Bash' || command) {
    const text = command ?? target ?? ''
    const shellItem: AgentTranscriptItem = {
      kind: 'shell_command',
      timestamp,
      command: text,
    }
    const cwd = stringField(input, 'workdir') ?? stringField(input, 'cwd')
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

function toolTarget(input: JsonRecord | undefined): string | undefined {
  if (!input) return undefined
  for (const key of ['path', 'file_path', 'filename', 'workdir', 'cwd', 'query', 'pattern']) {
    const value = stringField(input, key)
    if (value) return value
  }
  return undefined
}

function projectItems(
  items: AgentTranscriptItem[],
  projection: AgentTranscriptProjection,
  include: AgentTranscriptIncludeOptions | undefined,
): AgentTranscriptItem[] {
  const baseKinds = projectionKinds(projection)
  return items.filter(item => {
    if (isRawToolOutputItem(item) && include?.rawToolOutputs !== true) return false
    if (include && includeOverride(item, include) === true) return true
    if (include && includeOverride(item, include) === false) return false
    if (projection === 'final') return item.kind === 'assistant_message' && item.final === true
    return baseKinds.has(item.kind)
  })
}

function isRawToolOutputItem(item: AgentTranscriptItem): boolean {
  return item.kind === 'tool_read' && item.tool === 'function_call_output'
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
  if (!value) return undefined
  try {
    return asRecord(JSON.parse(value))
  } catch {
    return undefined
  }
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : undefined
}

function stringField(record: JsonRecord | undefined, key: string): string | undefined {
  const value = record?.[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
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

function dedupeAdjacentTranscriptItems(items: AgentTranscriptItem[]): AgentTranscriptItem[] {
  const deduped: AgentTranscriptItem[] = []
  for (const item of items) {
    const previous = deduped[deduped.length - 1]
    if (previous && transcriptItemsEquivalent(previous, item)) {
      // WHY Codex needs this normalization step:
      //
      // A single visible Codex assistant/user message is commonly recorded
      // twice: once as a high-level `event_msg` used by Agent Code's runtime
      // feed and once as a canonical `response_item` from the provider
      // rollout. Both are useful in raw transcript debugging, but this MCP
      // domain is deliberately a consumption boundary for another agent's work
      // product. Returning both makes searches look like duplicate findings
      // and makes `contextItems` echo the same sentence before/after itself.
      // We only collapse adjacent equivalent normalized items so distinct
      // repeated messages still survive when the transcript actually contains
      // separate turns.
      if (previous.kind === 'assistant_message' && item.kind === 'assistant_message') {
        previous.final = previous.final || item.final
      }
      continue
    }
    deduped.push({ ...item })
  }
  return deduped
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

function markFallbackFinal(items: AgentTranscriptItem[]): void {
  if (items.some(item => item.kind === 'assistant_message' && item.final)) return
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item?.kind === 'assistant_message') {
      item.final = true
      return
    }
  }
}
