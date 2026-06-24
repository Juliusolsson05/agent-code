import { basename, dirname, join } from 'node:path'
import { readdir, stat } from 'node:fs/promises'
import type { JsonlEntry, SubAgentState, SubAgentToolCall } from '@preload/api/types.js'
import { asRecord } from '@shared/lib/asRecord.js'
import {
  capToolCalls,
  headlineFromInput,
  readRange,
  SUBAGENT_TOOL_CALLS_MAX,
  tsToMs,
} from './shared.js'

const CODEX_SUBAGENT_NOTIFICATION_OPEN = '<subagent_notification>'
const CODEX_SUBAGENT_NOTIFICATION_CLOSE = '</subagent_notification>'

// Match SubAgentWatcher's cap name/value (PR #300) on purpose: this is the
// Codex twin of the Claude subagent retention leak that #300 fixed. Keeping the
// constant identical means a future reader who knows one watcher's bound knows
// the other's, and a single value to tune covers both providers.
//
// REVIEW NOTE (PR #317): the original #288 fix tail-sliced the RETAINED entries
// to this many and then fed that capped slice straight into the emit path. Both
// reviewers (Claude + Codex) caught that this corrupts every value derived from
// the HEAD of the rollout: `childMetaFromEntries` finds session_meta at the
// front (so role/nickname/parentThreadId and the startedAt anchor vanish once
// the head is dropped), `startedAt` jumps forward to the oldest *surviving*
// entry, and `turnCount` / tool-call counts undercount because earlier turns are
// gone. The fix below SPLITS the responsibility: the emitted tool-call timeline
// is capped, while the SubAgentState fields that depend on the HEAD of the file
// are derived from a running accumulator that has seen every complete line.
//
// #288 ROOT-CAUSE FOLLOW-UP: PR #317 also retained a bounded 500-entry TAIL of
// raw rollout entries in `childEntriesByAgentId`, justified ONLY as a buffer for
// a "future live mini-feed" that nothing ever read. The dominator-tree analysis
// that pinned the Claude SubAgentWatcher as 263 MB / 88% of the heap (see
// SubAgentWatcher.ts) showed retained raw entries are exactly the multi-MB
// liability — each entry pins its full tool-result/Read body. Since that tail
// was write-only dead weight here, the cleanest fix is to DROP it entirely
// rather than add per-field truncation to bytes nothing displays. The derived
// SubAgentState accumulator already carries everything emit() ships, so
// removing the tail is invisible. If a mini-feed is ever built, it should
// re-derive small previews from the on-disk rollout (the durable source), not
// pin raw entries in main-process heap. The former
// MAX_RETAINED_ENTRIES_PER_AGENT constant is gone with the tail it bounded; the
// dirty signal is now the child rollout byte offset, matching the Claude watcher
// and avoiding full-file re-reads.

// Codex child sessions do not use Claude's `<parent>/subagents/agent-*.jsonl`
// layout. They are normal rollout files whose session_meta.source says they
// were spawned by a parent thread, while the parent thread only learns the child
// thread id from the `spawn_agent` function_call_output. This module keeps that
// provider-specific correlation local and still emits the same SubAgentState
// contract the Claude renderer already consumes.

type CodexRolloutEntry = JsonlEntry

type SpawnCall = {
  callId: string
  agentType: string
  description: string
}

type SpawnOutput = {
  callId: string
  agentId: string
  nickname: string | null
}

type Notification = {
  agentId: string
  status: string | null
}

type ChildMeta = {
  id: string
  parentThreadId: string | null
  nickname: string | null
  role: string | null
  timestamp: string | null
}

type CodexToolCallAcc = SubAgentToolCall & { id: string | null }

type CodexSubAgentAccumulator = {
  childMeta: ChildMeta | null
  minTimestampMs: number | null
  maxTimestampMs: number | null
  taskComplete: boolean
  turnCount: number
  totalToolUses: number
  currentActivity: string | null
  toolCalls: CodexToolCallAcc[]
  openToolCallIds: Set<string>
  resolvedToolCallIds: Set<string>
}

const CODEX_SUBAGENT_HEADLINE_KEYS = [
  'command',
  'file_path',
  'path',
  'pattern',
  'query',
  'url',
  'description',
  'message',
] as const

// Keep a little more than the displayed 40 calls so a result arriving shortly
// after a burst can still flip a visible row. The true dropped count comes from
// totalToolUses, not from this ring length, so the ring is only a display cache.
const CODEX_SUBAGENT_RING_MAX = Math.max(60, SUBAGENT_TOOL_CALLS_MAX)

function stringField(record: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = record?.[key]
  return typeof value === 'string' ? value : null
}

function parseJsonObject(text: string | null): Record<string, unknown> | null {
  if (!text) return null
  try {
    return asRecord(JSON.parse(text))
  } catch {
    return null
  }
}

// Flatten a Codex function_call_output `output` field down to plain text.
//
// WHY this needs to handle THREE shapes (feed audit Finding 11): the ATP type
// contract (`CodexFunctionCallOutputPayload.output`) permits a plain string, a
// `{ text }` object, OR a structured content array like
// `[{ type: 'text', text: '…' }, …]`. `extractCodexSpawnOutput` used to read only
// the first two, so when `spawn_agent` returned ARRAY output the join key
// (`agent_id`) could not be parsed, the parent↔child correlation silently failed,
// and the committed TaskSubagentRow showed no live child state even though the
// spawn succeeded. ATP already normalizes array output elsewhere; this is the
// main-process twin so the subagent path makes the same decision.
//
// The output here is a JOIN KEY, not user-visible transcript content, so we are
// deliberately conservative: only pull `text` from each array item (concatenated
// with newlines, matching how a single multi-chunk JSON string would arrive),
// and never blindly `JSON.stringify` an unknown object — that could fabricate an
// `agent_id` parse from unrelated payload. Array items without a string `text`
// contribute nothing; an array with no text at all returns null.
export function textFromCodexOutput(output: unknown): string | null {
  if (typeof output === 'string') return output
  if (Array.isArray(output)) {
    const parts = output.flatMap(item => {
      const rec = asRecord(item)
      return typeof rec?.text === 'string' ? [rec.text] : []
    })
    return parts.length > 0 ? parts.join('\n') : null
  }
  const rec = asRecord(output)
  return typeof rec?.text === 'string' ? rec.text : null
}

export function isCodexRolloutEntry(entry: JsonlEntry): boolean {
  // Match the renderer's rollout discriminator. Some Codex side-channel
  // records, notably turn_context/compacted variants, do not need a
  // payload.type to still be Codex rollout entries. If we required one here,
  // those records would fall through to the Claude sidecar watcher and create
  // useless polling against a derived `rollout-.../subagents` directory.
  return (
    entry.type === 'session_meta' ||
    entry.type === 'response_item' ||
    entry.type === 'event_msg' ||
    entry.type === 'turn_context' ||
    entry.type === 'compacted'
  )
}

export function codexProviderSessionId(entry: JsonlEntry): string | null {
  if (entry.type !== 'session_meta') return null
  const payload = asRecord(entry.payload)
  return stringField(payload, 'id')
}

export function extractCodexSpawnCall(entry: JsonlEntry): SpawnCall | null {
  if (entry.type !== 'response_item') return null
  const payload = asRecord(entry.payload)
  if (
    payload?.type !== 'function_call' ||
    payload.name !== 'spawn_agent' ||
    typeof payload.call_id !== 'string'
  ) {
    return null
  }
  const args = typeof payload.arguments === 'string'
    ? parseJsonObject(payload.arguments)
    : asRecord(payload.arguments)
  const input = asRecord(args)
  return {
    callId: payload.call_id,
    agentType: stringField(input, 'agent_type') ?? 'agent',
    description: stringField(input, 'message') ?? stringField(input, 'description') ?? '',
  }
}

export function extractCodexSpawnOutput(entry: JsonlEntry): SpawnOutput | null {
  if (entry.type !== 'response_item') return null
  const payload = asRecord(entry.payload)
  if (payload?.type !== 'function_call_output' || typeof payload.call_id !== 'string') {
    return null
  }
  // Handles string, { text }, AND structured `[{ text }]` array output so a
  // spawn_agent result delivered as a content array still yields its agent_id
  // join key (feed audit Finding 11).
  const outputText = textFromCodexOutput(payload.output)
  const output = parseJsonObject(outputText)
  const agentId = stringField(output, 'agent_id')
  if (!agentId) return null
  return {
    callId: payload.call_id,
    agentId,
    nickname: stringField(output, 'nickname'),
  }
}

export function extractCodexSubagentNotification(entry: JsonlEntry): Notification | null {
  if (entry.type !== 'response_item') return null
  const payload = asRecord(entry.payload)
  if (payload?.type !== 'message' || payload.role !== 'user') return null
  const content = Array.isArray(payload.content) ? payload.content : []
  for (const block of content) {
    const item = asRecord(block)
    const text = typeof item?.text === 'string' ? item.text.trim() : ''
    if (!text.startsWith(CODEX_SUBAGENT_NOTIFICATION_OPEN)) continue
    const body = text
      .slice(CODEX_SUBAGENT_NOTIFICATION_OPEN.length)
      .replace(CODEX_SUBAGENT_NOTIFICATION_CLOSE, '')
      .trim()
    const parsed = parseJsonObject(body)
    const agentId = stringField(parsed, 'agent_path')
    if (!agentId) return null
    return { agentId, status: stringField(parsed, 'status') }
  }
  return null
}

export function extractCodexChildMeta(entry: JsonlEntry): ChildMeta | null {
  if (entry.type !== 'session_meta') return null
  const payload = asRecord(entry.payload)
  const id = stringField(payload, 'id')
  if (!id) return null
  // `payload?.source`: payload is provably non-null here at runtime (a null
  // payload yields a null `id` and returns above), but the `stringField` result
  // does not narrow `payload` for the type checker. Optional-chain so this is
  // tsc-clean under a typecheck gate without changing behavior (cross-app audit
  // V2 — these latent narrowing gaps only ever compiled because nothing ran tsc).
  const source = asRecord(payload?.source)
  const subagent = asRecord(source?.subagent)
  const threadSpawn = asRecord(subagent?.thread_spawn)
  return {
    id,
    parentThreadId: stringField(threadSpawn, 'parent_thread_id'),
    nickname: stringField(threadSpawn, 'agent_nickname'),
    role: stringField(threadSpawn, 'agent_role'),
    timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : null,
  }
}

function childMetaFromEntries(entries: CodexRolloutEntry[]): ChildMeta | null {
  for (const entry of entries) {
    const meta = extractCodexChildMeta(entry)
    if (meta) return meta
  }
  return null
}

function toolInputFromPayload(payload: Record<string, unknown>): Record<string, unknown> | null {
  if (typeof payload.arguments === 'string') {
    return parseJsonObject(payload.arguments) ?? { arguments: payload.arguments }
  }
  if (typeof payload.input === 'string') {
    return parseJsonObject(payload.input) ?? { raw: payload.input }
  }
  return asRecord(payload.arguments) ?? asRecord(payload.input)
}

function buildToolCalls(entries: CodexRolloutEntry[]): {
  calls: SubAgentToolCall[]
  dropped: number
  currentActivity: string | null
} {
  type Call = SubAgentToolCall & { id: string | null }
  const calls: Call[] = []
  const done = new Set<string>()
  let currentActivity: string | null = null

  for (const entry of entries) {
    const payload = asRecord(entry.payload)
    if (!payload) continue
    if (
      entry.type === 'response_item' &&
      (payload.type === 'function_call' || payload.type === 'custom_tool_call') &&
      typeof payload.call_id === 'string'
    ) {
      const name = stringField(payload, 'name') ?? 'tool'
      calls.push({
        id: payload.call_id,
        name,
        headline: headlineFromInput(
          toolInputFromPayload(payload),
          CODEX_SUBAGENT_HEADLINE_KEYS,
          '...',
        ),
        status: 'running',
      })
      currentActivity = `running ${name}`
    } else if (
      entry.type === 'response_item' &&
      (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') &&
      typeof payload.call_id === 'string'
    ) {
      done.add(payload.call_id)
      currentActivity = null
    } else if (entry.type === 'response_item' && payload.type === 'web_search_call') {
      const callId = stringField(payload, 'call_id') ?? stringField(payload, 'id')
      const action = asRecord(payload.action)
      calls.push({
        id: callId,
        name: 'web_search',
        headline: headlineFromInput(action, CODEX_SUBAGENT_HEADLINE_KEYS, '...'),
        status: 'running',
      })
      currentActivity = 'running web_search'
    } else if (entry.type === 'event_msg' && payload.type === 'agent_message') {
      const phase = stringField(payload, 'phase')
      currentActivity = phase === 'final_answer' ? 'finalizing' : 'responding'
    }
  }

  for (const call of calls) {
    call.status = call.id && done.has(call.id) ? 'done' : 'running'
  }

  const { kept, dropped } = capToolCalls(calls)
  return {
    calls: kept.map(({ name, headline, status }) => ({ name, headline, status })),
    dropped,
    currentActivity,
  }
}

export function buildCodexSubAgentState(params: {
  toolUseId: string
  agentId: string
  spawn: SpawnCall | null
  output: SpawnOutput | null
  notification: Notification | null
  childEntries: CodexRolloutEntry[]
}): SubAgentState {
  const childMeta = childMetaFromEntries(params.childEntries)
  const timestamps = params.childEntries
    .map(entry => (typeof entry.timestamp === 'string' ? tsToMs(entry.timestamp) : null))
    .filter((value): value is number => value !== null)
  const startedAt =
    tsToMs(childMeta?.timestamp) ??
    (timestamps.length > 0 ? Math.min(...timestamps) : null)
  const lastActivityAt = timestamps.length > 0 ? Math.max(...timestamps) : startedAt
  const taskComplete = params.childEntries.some(entry => {
    const payload = asRecord(entry.payload)
    return entry.type === 'event_msg' && payload?.type === 'task_complete'
  })
  const status: SubAgentState['status'] =
    params.notification?.status === 'failed' || params.notification?.status === 'error'
      ? 'error'
      : params.notification?.status === 'completed' || taskComplete
        ? 'done'
        : 'running'
  const tools = buildToolCalls(params.childEntries)
  const turnCount = params.childEntries.reduce((count, entry) => {
    const payload = asRecord(entry.payload)
    if (entry.type === 'event_msg' && payload?.type === 'agent_message') return count + 1
    if (
      entry.type === 'response_item' &&
      payload?.type === 'message' &&
      payload.role === 'assistant'
    ) {
      return count + 1
    }
    return count
  }, 0)

  return {
    toolUseId: params.toolUseId,
    agentId: params.agentId,
    agentType: childMeta?.role ?? params.spawn?.agentType ?? 'agent',
    description:
      params.spawn?.description ??
      childMeta?.nickname ??
      params.output?.nickname ??
      '',
    status,
    startedAt,
    lastActivityAt,
    turnCount,
    toolCalls: tools.calls,
    droppedToolCalls: tools.dropped,
    currentActivity: status === 'running' ? tools.currentActivity : null,
  }
}

function createCodexAccumulator(): CodexSubAgentAccumulator {
  return {
    childMeta: null,
    minTimestampMs: null,
    maxTimestampMs: null,
    taskComplete: false,
    turnCount: 0,
    totalToolUses: 0,
    currentActivity: null,
    toolCalls: [],
    openToolCallIds: new Set(),
    resolvedToolCallIds: new Set(),
  }
}

function pushCodexToolCall(
  acc: CodexSubAgentAccumulator,
  call: CodexToolCallAcc,
): void {
  acc.totalToolUses += 1
  if (call.id) {
    if (acc.resolvedToolCallIds.has(call.id)) {
      call.status = 'done'
      // This was a result-before-call case. Once the call arrives and consumes
      // the pending result, the id is no longer needed. Keeping every resolved id
      // would turn the incremental fold into another O(transcript) retained set.
      acc.resolvedToolCallIds.delete(call.id)
    } else {
      acc.openToolCallIds.add(call.id)
    }
  }
  acc.toolCalls.push(call)
  if (acc.toolCalls.length > CODEX_SUBAGENT_RING_MAX) acc.toolCalls.shift()
}

function resolveCodexToolCall(
  acc: CodexSubAgentAccumulator,
  callId: string,
): void {
  const wasOpen = acc.openToolCallIds.delete(callId)
  if (!wasOpen) {
    acc.resolvedToolCallIds.add(callId)
  }
  for (const call of acc.toolCalls) {
    if (call.id === callId) call.status = 'done'
  }
}

function accumulateCodexSubAgentEntry(
  acc: CodexSubAgentAccumulator,
  entry: CodexRolloutEntry,
): void {
  const meta = extractCodexChildMeta(entry)
  if (meta && !acc.childMeta) acc.childMeta = meta
  const ms = typeof entry.timestamp === 'string' ? tsToMs(entry.timestamp) : null
  if (ms !== null) {
    acc.minTimestampMs = acc.minTimestampMs === null ? ms : Math.min(acc.minTimestampMs, ms)
    acc.maxTimestampMs = acc.maxTimestampMs === null ? ms : Math.max(acc.maxTimestampMs, ms)
  }

  const payload = asRecord(entry.payload)
  if (!payload) return
  if (
    entry.type === 'response_item' &&
    (payload.type === 'function_call' || payload.type === 'custom_tool_call') &&
    typeof payload.call_id === 'string'
  ) {
    const name = stringField(payload, 'name') ?? 'tool'
    pushCodexToolCall(acc, {
      id: payload.call_id,
      name,
      headline: headlineFromInput(
        toolInputFromPayload(payload),
        CODEX_SUBAGENT_HEADLINE_KEYS,
        '...',
      ),
      status: 'running',
    })
    acc.currentActivity = `running ${name}`
  } else if (
    entry.type === 'response_item' &&
    (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') &&
    typeof payload.call_id === 'string'
  ) {
    resolveCodexToolCall(acc, payload.call_id)
    acc.currentActivity = null
  } else if (entry.type === 'response_item' && payload.type === 'web_search_call') {
    const callId = stringField(payload, 'call_id') ?? stringField(payload, 'id')
    const action = asRecord(payload.action)
    pushCodexToolCall(acc, {
      id: callId,
      name: 'web_search',
      headline: headlineFromInput(action, CODEX_SUBAGENT_HEADLINE_KEYS, '...'),
      status: 'running',
    })
    acc.currentActivity = 'running web_search'
  } else if (entry.type === 'event_msg' && payload.type === 'task_complete') {
    acc.taskComplete = true
  } else if (entry.type === 'event_msg' && payload.type === 'agent_message') {
    const phase = stringField(payload, 'phase')
    acc.turnCount += 1
    acc.currentActivity = phase === 'final_answer' ? 'finalizing' : 'responding'
  } else if (
    entry.type === 'response_item' &&
    payload.type === 'message' &&
    payload.role === 'assistant'
  ) {
    acc.turnCount += 1
  }
}

function buildCodexSubAgentStateFromAccumulator(params: {
  toolUseId: string
  agentId: string
  spawn: SpawnCall | null
  output: SpawnOutput | null
  notification: Notification | null
  acc: CodexSubAgentAccumulator | null
}): SubAgentState {
  const acc = params.acc ?? createCodexAccumulator()
  const childMeta = acc.childMeta
  const startedAt =
    tsToMs(childMeta?.timestamp) ??
    acc.minTimestampMs
  const status: SubAgentState['status'] =
    params.notification?.status === 'failed' || params.notification?.status === 'error'
      ? 'error'
      : params.notification?.status === 'completed' || acc.taskComplete
        ? 'done'
        : 'running'
  const { kept } = capToolCalls(acc.toolCalls)

  return {
    toolUseId: params.toolUseId,
    agentId: params.agentId,
    agentType: childMeta?.role ?? params.spawn?.agentType ?? 'agent',
    description:
      params.spawn?.description ??
      childMeta?.nickname ??
      params.output?.nickname ??
      '',
    status,
    startedAt,
    lastActivityAt: acc.maxTimestampMs ?? startedAt,
    turnCount: acc.turnCount,
    toolCalls: kept.map(({ name, headline, status }) => ({ name, headline, status })),
    droppedToolCalls: Math.max(0, acc.totalToolUses - SUBAGENT_TOOL_CALLS_MAX),
    currentActivity: status === 'running' ? acc.currentActivity : null,
  }
}

function sessionsRootFromRolloutPath(path: string): string | null {
  let dir = dirname(path)
  for (;;) {
    if (basename(dir) === 'sessions') return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

async function findFileContaining(root: string, needle: string): Promise<string | null> {
  async function walk(dir: string): Promise<string | null> {
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      return null
    }
    for (const entry of entries) {
      const path = join(dir, entry)
      let info
      try {
        info = await stat(path)
      } catch {
        continue
      }
      if (info.isDirectory()) {
        const found = await walk(path)
        if (found) return found
      } else if (entry.endsWith('.jsonl') && entry.includes(needle)) {
        return path
      }
    }
    return null
  }
  return walk(root)
}

export class CodexSubAgentTracker {
  private readonly spawnsByCallId = new Map<string, SpawnCall>()
  private readonly outputsByCallId = new Map<string, SpawnOutput>()
  private readonly callIdByAgentId = new Map<string, string>()
  private readonly notificationsByAgentId = new Map<string, Notification>()
  private readonly childPathByAgentId = new Map<string, string>()
  // Byte-offset fold state per child rollout. The pre-fix Codex tracker read
  // and parsed the whole child file every 1.2s while a child was active. That
  // was correct but made polling cost grow with transcript length. These maps
  // mirror the Claude SubAgentWatcher lifetime: append-only bytes are folded
  // into a tiny accumulator, complete lines are dropped immediately, and emit()
  // derives from the accumulator plus the parent correlation maps.
  private readonly childOffsetByAgentId = new Map<string, number>()
  private readonly childPartialByAgentId = new Map<string, string>()
  private readonly childAccByAgentId = new Map<string, CodexSubAgentAccumulator>()
  private timer: NodeJS.Timeout | null = null
  private parentFile: string | null = null
  private dirty = false
  private stopped = false

  constructor(private readonly onChange: (subAgents: Record<string, SubAgentState>) => void) {}

  observeParentEntry(entry: JsonlEntry, file: string): void {
    this.parentFile = file
    const spawn = extractCodexSpawnCall(entry)
    if (spawn) {
      this.spawnsByCallId.set(spawn.callId, spawn)
      this.dirty = true
    }
    const output = extractCodexSpawnOutput(entry)
    if (output) {
      this.outputsByCallId.set(output.callId, output)
      this.callIdByAgentId.set(output.agentId, output.callId)
      // Correlation changed for this agent. The child rollout bytes may not grow
      // at the same moment, but emit() still needs to rebuild the record with the
      // parent spawn/output metadata. Mark dirty without touching the byte offset;
      // the accumulator remains the source of truth for child-derived fields.
      this.dirty = true
    }
    const notification = extractCodexSubagentNotification(entry)
    if (notification) {
      this.notificationsByAgentId.set(notification.agentId, notification)
      // Notification status is parent-rollout metadata, not child bytes. A
      // completion notice must repaint even when the child file is quiescent.
      this.dirty = true
    }
    if (this.knownAgentIds().length > 0) this.ensureTimer()
    void this.refresh()
  }

  private ensureTimer(): void {
    if (!this.timer) {
      // Codex child rollouts are independent session files, so the parent file
      // does not grow when the child takes a tool step. Polling keeps the UI in
      // sync without depending on private Codex runtime hooks. We arm it only
      // after a child id exists; ordinary Codex panes otherwise created a
      // perpetual no-op timer for their whole lifetime.
      this.timer = setInterval(() => void this.refresh(), 1200)
    }
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    // Mirror SubAgentWatcher.stop() (PR #300): clearing the timer alone left
    // every retained child rollout entry — plus the spawn/output/notification
    // correlation maps — pinned in main-process heap for the lifetime of the
    // process even though a stopped tracker can never emit again. A stopped
    // session must release its memory; the durable source stays the on-disk
    // rollout if the tracker is ever re-created for the same parent.
    this.spawnsByCallId.clear()
    this.outputsByCallId.clear()
    this.callIdByAgentId.clear()
    this.notificationsByAgentId.clear()
    this.childPathByAgentId.clear()
    this.childOffsetByAgentId.clear()
    this.childPartialByAgentId.clear()
    this.childAccByAgentId.clear()
  }

  async refresh(): Promise<void> {
    if (this.stopped || !this.parentFile) return
    await this.readKnownChildren()
    // POST-AWAIT stop guard (PR #317, race fix). The pre-await check above only
    // proves we were not stopped when refresh() started. readKnownChildren()
    // awaits file IO, and stop() can run during that window — clearing every map
    // and the timer. Without this guard a refresh already in flight would sail
    // past stop(), repopulate state via readKnownChildren()'s writes, and emit()
    // a payload for a session the rest of the system believes is dead. Re-check
    // after every await so a stopped tracker can never repopulate or emit.
    if (this.stopped) return
    if (!this.dirty) return
    this.dirty = false
    this.emit()
  }

  private knownAgentIds(): string[] {
    return Array.from(
      new Set([
        ...Array.from(this.callIdByAgentId.keys()),
        ...Array.from(this.notificationsByAgentId.keys()),
      ]),
    )
  }

  private async readKnownChildren(): Promise<void> {
    const root = this.parentFile ? sessionsRootFromRolloutPath(this.parentFile) : null
    if (!root) return
    for (const agentId of this.knownAgentIds()) {
      // Per-iteration stop guard (PR #317). This loop awaits IO between every
      // child; stop() can land mid-loop and clear the maps. Bail immediately so
      // we never write derived state back into a tracker that has been torn down.
      if (this.stopped) return
      let path = this.childPathByAgentId.get(agentId) ?? null
      if (!path) {
        path = await findFileContaining(root, agentId)
        if (this.stopped) return
        if (path) this.childPathByAgentId.set(agentId, path)
      }
      if (!path) continue
      const changed = await this.readAppendedChild(agentId, path)
      if (this.stopped) return
      if (changed) this.dirty = true
    }
  }

  private async readAppendedChild(agentId: string, path: string): Promise<boolean> {
    const { size } = await stat(path)
    let from = this.childOffsetByAgentId.get(agentId) ?? 0
    if (size < from) {
      // Rollouts are append-only in normal Codex operation, but editors/tests can
      // truncate or rewrite files. A byte offset past EOF would permanently miss
      // the new head, so reset the fold and replay from byte 0. This is a rare
      // correctness fallback, not the hot path.
      from = 0
      this.childPartialByAgentId.delete(agentId)
      this.childAccByAgentId.set(agentId, createCodexAccumulator())
    }
    if (size <= from) return false

    const appended = await readRange(path, from, size)
    const text = (this.childPartialByAgentId.get(agentId) ?? '') + appended.text
    const lastNl = text.lastIndexOf('\n')
    this.childOffsetByAgentId.set(agentId, appended.nextOffset)
    if (lastNl < 0) {
      this.childPartialByAgentId.set(agentId, text)
      return false
    }

    const complete = text.slice(0, lastNl)
    this.childPartialByAgentId.set(agentId, text.slice(lastNl + 1))
    let acc = this.childAccByAgentId.get(agentId)
    if (!acc) {
      acc = createCodexAccumulator()
      this.childAccByAgentId.set(agentId, acc)
    }
    let changed = false
    for (const line of complete.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        accumulateCodexSubAgentEntry(acc, JSON.parse(trimmed) as CodexRolloutEntry)
        changed = true
      } catch {
        // Rollout files can be caught mid-append or externally edited. Skipping
        // a malformed complete line matches the old full-read behavior without
        // poisoning the accumulator or re-reading the whole file next tick.
      }
    }
    return changed
  }

  private emit(): void {
    const out: Record<string, SubAgentState> = {}
    for (const [agentId, callId] of this.callIdByAgentId) {
      out[callId] = buildCodexSubAgentStateFromAccumulator({
        toolUseId: callId,
        agentId,
        spawn: this.spawnsByCallId.get(callId) ?? null,
        output: this.outputsByCallId.get(callId) ?? null,
        notification: this.notificationsByAgentId.get(agentId) ?? null,
        acc: this.childAccByAgentId.get(agentId) ?? null,
      })
    }
    this.onChange(out)
  }
}
