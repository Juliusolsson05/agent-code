import { basename, dirname, join } from 'node:path'
import { readFile, readdir, stat } from 'node:fs/promises'
import type { JsonlEntry, SubAgentState, SubAgentToolCall } from '@preload/api/types.js'
import { asRecord } from '@shared/lib/asRecord.js'

const CODEX_SUBAGENT_NOTIFICATION_OPEN = '<subagent_notification>'
const CODEX_SUBAGENT_NOTIFICATION_CLOSE = '</subagent_notification>'

// Match SubAgentWatcher's cap name/value (PR #300) on purpose: this is the
// Codex twin of the Claude subagent retention leak that #300 fixed. Keeping the
// constant identical means a future reader who knows one watcher's bound knows
// the other's, and a single value to tune covers both providers.
const MAX_RETAINED_ENTRIES_PER_AGENT = 500

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

function stringField(record: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = record?.[key]
  return typeof value === 'string' ? value : null
}

function tsToMs(ts: string | null | undefined): number | null {
  if (!ts) return null
  const n = Date.parse(ts)
  return Number.isFinite(n) ? n : null
}

function headlineFromInput(input: Record<string, unknown> | null): string | null {
  if (!input) return null
  // Keep this intentionally aligned with the Claude subagent builder and the
  // normal tool row headline priority. A child mini-feed is only useful if it
  // scans like the parent feed; inventing Codex-only labels here would make the
  // same tool call read differently depending on where it is rendered.
  for (const key of [
    'command',
    'file_path',
    'path',
    'pattern',
    'query',
    'url',
    'description',
    'message',
  ]) {
    const value = input[key]
    if (typeof value === 'string' && value.length > 0) {
      return value.length > 80 ? `${value.slice(0, 80)}...` : value
    }
  }
  return null
}

function parseJsonObject(text: string | null): Record<string, unknown> | null {
  if (!text) return null
  try {
    return asRecord(JSON.parse(text))
  } catch {
    return null
  }
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
  const outputText =
    typeof payload.output === 'string'
      ? payload.output
      : typeof asRecord(payload.output)?.text === 'string'
        ? String(asRecord(payload.output)?.text)
        : null
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
  const source = asRecord(payload.source)
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
        headline: headlineFromInput(toolInputFromPayload(payload)),
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
        headline: headlineFromInput(action),
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

  const max = 40
  const dropped = calls.length > max ? calls.length - max : 0
  const kept = dropped > 0 ? calls.slice(dropped) : calls
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

async function readRolloutEntries(path: string): Promise<CodexRolloutEntry[]> {
  const text = await readFile(path, 'utf8')
  const entries: CodexRolloutEntry[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      entries.push(JSON.parse(trimmed) as CodexRolloutEntry)
    } catch {
      // Rollout files can be caught mid-append. Dropping one malformed line is
      // better than poisoning the whole subagent state; the poller will read a
      // complete version on the next tick.
    }
  }
  return entries
}

export class CodexSubAgentTracker {
  private readonly spawnsByCallId = new Map<string, SpawnCall>()
  private readonly outputsByCallId = new Map<string, SpawnOutput>()
  private readonly callIdByAgentId = new Map<string, string>()
  private readonly notificationsByAgentId = new Map<string, Notification>()
  private readonly childPathByAgentId = new Map<string, string>()
  private readonly childEntriesByAgentId = new Map<string, CodexRolloutEntry[]>()
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
      this.dirty = true
    }
    const notification = extractCodexSubagentNotification(entry)
    if (notification) {
      this.notificationsByAgentId.set(notification.agentId, notification)
      this.dirty = true
    }
    if (!this.timer) {
      // Codex child rollouts are independent session files, so the parent file
      // does not grow when the child takes a tool step. Polling keeps the UI in
      // sync without depending on private Codex runtime hooks.
      this.timer = setInterval(() => void this.refresh(), 1200)
    }
    void this.refresh()
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
    this.childEntriesByAgentId.clear()
  }

  async refresh(): Promise<void> {
    if (this.stopped || !this.parentFile) return
    await this.readKnownChildren()
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
      let path = this.childPathByAgentId.get(agentId) ?? null
      if (!path) {
        path = await findFileContaining(root, agentId)
        if (path) this.childPathByAgentId.set(agentId, path)
      }
      if (!path) continue
      const entries = await readRolloutEntries(path)
      const previous = this.childEntriesByAgentId.get(agentId)
      if (!previous || previous.length !== entries.length) {
        // Bound retained entries per agent — the Codex twin of PR #300's cap on
        // SubAgentWatcher. `readRolloutEntries` re-reads the whole child rollout
        // every ~1.2s tick, so without a cap a long-running child grows this
        // map's arrays without limit and duplicates large tool-result strings in
        // main-process heap. The renderer payload is separately capped inside
        // buildCodexSubAgentState (buildToolCalls keeps the last 40 calls), so
        // this cap only protects the main process. Retain the TAIL — the most
        // recent entries — because that is where current activity, completion
        // events, and recent tool context live; the durable full transcript
        // stays on disk in the rollout file.
        //
        // NOTE: unlike Claude's append-only offset tail (#300), this still reads
        // the entire file each tick. An offset/incremental read would also cut
        // read amplification, but it is a larger change against these helpers;
        // the tail-cap is the safe, sufficient memory bound for this PR.
        const bounded =
          entries.length > MAX_RETAINED_ENTRIES_PER_AGENT
            ? entries.slice(entries.length - MAX_RETAINED_ENTRIES_PER_AGENT)
            : entries
        this.childEntriesByAgentId.set(agentId, bounded)
        this.dirty = true
      }
    }
  }

  private emit(): void {
    const out: Record<string, SubAgentState> = {}
    for (const [agentId, callId] of this.callIdByAgentId) {
      out[callId] = buildCodexSubAgentState({
        toolUseId: callId,
        agentId,
        spawn: this.spawnsByCallId.get(callId) ?? null,
        output: this.outputsByCallId.get(callId) ?? null,
        notification: this.notificationsByAgentId.get(agentId) ?? null,
        childEntries: this.childEntriesByAgentId.get(agentId) ?? [],
      })
    }
    this.onChange(out)
  }
}
