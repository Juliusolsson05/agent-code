import { basename, dirname, join } from 'node:path'
import { readdir, stat } from 'node:fs/promises'
import type { JsonlEntry, SubAgentState, SubAgentToolCall } from '@preload/api/types.js'
import { asRecord } from '@shared/lib/asRecord.js'
import { CoalescedRefresh } from './CoalescedRefresh.js'
import {
  capToolCalls,
  headlineFromInput,
  readRange,
  SUBAGENT_TOOL_CALLS_MAX,
  tsToMs,
} from './shared.js'

const CODEX_SUBAGENT_NOTIFICATION_OPEN = '<subagent_notification>'
const CODEX_SUBAGENT_NOTIFICATION_CLOSE = '</subagent_notification>'

// This module is the Codex twin of the Claude subagent retention fix
// (SubAgentWatcher, PR #300, root-caused in #288): a child rollout is folded
// incrementally into a tiny accumulator and its raw lines are dropped the
// instant they are consumed, so main-process heap never grows with transcript
// length. The dominator-tree analysis that pinned the Claude watcher at 263 MB
// / 88% of the heap (see SubAgentWatcher.ts) showed retained raw entries are
// the multi-MB liability — each pins its full tool-result / Read body — which
// is why nothing here holds a tail of raw entries. The dirty signal is the
// child rollout byte offset, matching the Claude watcher and avoiding full-file
// re-reads.
//
// INVARIANT (#288 / #317 root cause, stated forward): every head-of-file
// SubAgentState field — role / nickname / parentThreadId, the startedAt anchor,
// turnCount, and the tool-call counts — MUST derive from the running
// accumulator that has seen every complete line, NOT from a capped tail slice.
// Deriving any head-derived value from the slice corrupts it: session_meta
// lives at the FRONT of the rollout (so role/nickname/parentThreadId and the
// startedAt anchor vanish once the head is dropped), startedAt jumps forward to
// the oldest surviving entry, and turn/tool counts undercount because earlier
// turns are gone. The split below honors this — the emitted tool-call timeline
// is capped for DISPLAY, while every head-derived field reads from the
// accumulator. A prior fix tail-sliced retained entries and fed that slice
// straight into emit, which is exactly what this invariant forbids.

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
// and the committed Codex spawn row showed no live child state even though the
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
  // WHY this main-process tracker still reads only the historical `agent_type`
  // generation: the current renderer can truthfully present `task_name`, but
  // subagent-state correlation additionally needs a durable child identifier.
  // Current spawn results expose a task name rather than the old agent UUID, so
  // pretending the tracker supports them would attach unrelated live state.
  // TODO(native-collaboration-identity): add the task_name generation only when
  // the provider exposes a stable parent-call -> child-session join key.
  const agentType = stringField(input, 'agent_type')
  if (!agentType) return null
  return {
    callId: payload.call_id,
    agentType,
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

/** Parent `wait_agent` function_call tracking: outputs carry the fan-in
 *  truth `{"status":{"<agent-uuid>":{"completed"|"failed"|"error"|
 *  "interrupted": <result text>}}}` (shape verified against on-disk
 *  rollouts 2026-06-18). Codex has NO subagent notification on this path —
 *  for MCP-spawned children this output is the ONLY terminal signal the
 *  parent ever records (#341's stuck-running root cause). */
export function isCodexWaitAgentCall(entry: JsonlEntry): string | null {
  const payload = asRecord(entry.payload)
  if (!payload || entry.type !== 'response_item') return null
  if (payload.type !== 'function_call' && payload.type !== 'custom_tool_call') return null
  const name = stringField(payload, 'name')
  if (name !== 'wait_agent' && name !== 'wait_agents') return null
  return stringField(payload, 'call_id')
}

export function extractCodexWaitStatuses(
  entry: JsonlEntry,
  waitCallIds: ReadonlySet<string>,
): Map<string, 'done' | 'error'> | null {
  const payload = asRecord(entry.payload)
  if (!payload || entry.type !== 'response_item') return null
  if (payload.type !== 'function_call_output' && payload.type !== 'custom_tool_call_output') {
    return null
  }
  const callId = stringField(payload, 'call_id')
  if (!callId || !waitCallIds.has(callId)) return null
  const text = textFromCodexOutput(payload.output) ?? (typeof payload.output === 'string' ? payload.output : null)
  if (!text) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  const statusMap = asRecord(asRecord(parsed)?.status)
  if (!statusMap) return null
  const out = new Map<string, 'done' | 'error'>()
  for (const [agentId, v] of Object.entries(statusMap)) {
    const state = asRecord(v)
    if (!state) continue
    const keys = Object.keys(state)
    if (keys.includes('completed')) out.set(agentId, 'done')
    else if (keys.some(k => k === 'failed' || k === 'error' || k === 'interrupted')) {
      out.set(agentId, 'error')
    }
  }
  return out.size > 0 ? out : null
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

function toolInputFromPayload(payload: Record<string, unknown>): Record<string, unknown> | null {
  if (typeof payload.arguments === 'string') {
    return parseJsonObject(payload.arguments) ?? { arguments: payload.arguments }
  }
  if (typeof payload.input === 'string') {
    return parseJsonObject(payload.input) ?? { raw: payload.input }
  }
  return asRecord(payload.arguments) ?? asRecord(payload.input)
}

/** Mirrors SUBAGENT_STALE_AFTER_MS on the claude side (#341): a child
 *  with no rollout activity for 5 minutes while nominally running is
 *  presumed dead/hung — 'stale', never fabricated 'done'. */
export const CODEX_SUBAGENT_STALE_AFTER_MS = 5 * 60_000

/** Terminal children older than this get pruned from the tracker (#341):
 *  their truth is durable in the parent rollout by then. 10 minutes keeps
 *  the completed card interactive well past reading time without letting
 *  resumed sessions accumulate every child ever spawned. */
export const CODEX_SUBAGENT_PRUNE_AFTER_MS = 10 * 60_000

// Exported for the unit test, which exercises the accumulator exactly the way
// CodexSubAgentTracker.readAppendedChild does (fold each rollout line, then
// build). These three are the live emit path — the former entries-based
// builders (childMetaFromEntries/buildToolCalls/buildCodexSubAgentState) were
// a parallel oracle that nothing but the test used and were deleted, mirroring
// the claude twin's decision documented in subagentState.ts (dead parity
// oracles are removed, not kept in sync).
export function createCodexAccumulator(): CodexSubAgentAccumulator {
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

export function accumulateCodexSubAgentEntry(
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

export function buildCodexSubAgentStateFromAccumulator(params: {
  toolUseId: string
  agentId: string
  spawn: SpawnCall | null
  output: SpawnOutput | null
  notification: Notification | null
  /** Terminal state from the parent's wait_agent output (#341) — for
   *  MCP-spawned codex children this is the only terminal signal. */
  waitTerminal?: 'done' | 'error' | null
  acc: CodexSubAgentAccumulator | null
  nowMs?: number
}): SubAgentState {
  const acc = params.acc ?? createCodexAccumulator()
  const childMeta = acc.childMeta
  const startedAt =
    tsToMs(childMeta?.timestamp) ??
    acc.minTimestampMs
  const nowMs = params.nowMs ?? Date.now()
  const status: SubAgentState['status'] =
    params.notification?.status === 'failed' ||
    params.notification?.status === 'error' ||
    params.waitTerminal === 'error'
      ? 'error'
      : params.notification?.status === 'completed' ||
          acc.taskComplete ||
          params.waitTerminal === 'done'
        ? 'done'
        : acc.maxTimestampMs !== null && nowMs - acc.maxTimestampMs > CODEX_SUBAGENT_STALE_AFTER_MS
          ? 'stale'
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

// Bound negative discovery independently of the 1.2 s activity poll. A new
// child may wait up to this interval + one poll + scan time, but parent bursts
// (including bursts of newly spawned ids) cannot defeat the scan budget.
export const CODEX_CHILD_DISCOVERY_RETRY_MS = 5000

async function findChildRollouts(
  root: string,
  missing: Set<string>,
  stopped: () => boolean,
): Promise<Map<string, string>> {
  const found = new Map<string, string>()
  async function walk(dir: string): Promise<void> {
    if (stopped() || found.size === missing.size) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return // A newly created/moved date directory is retried next window.
    }
    for (const entry of entries) {
      if (stopped() || found.size === missing.size) return
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(path)
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        // Directory-entry types remove one stat per archived file. In
        // particular, never follow symlinks: a linked ancestor can recurse
        // forever, and a linked foreign archive is not this root's discovery
        // authority. Retain only matches for currently tracked children.
        for (const id of missing) {
          if (!found.has(id) && entry.name.includes(id)) found.set(id, path)
        }
      }
    }
  }
  await walk(root)
  return found
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
  private readonly waitCallIds = new Set<string>()
  private readonly waitTerminalByAgentId = new Map<string, 'done' | 'error'>()
  private readonly childOffsetByAgentId = new Map<string, number>()
  private readonly childPartialByAgentId = new Map<string, string>()
  private readonly childAccByAgentId = new Map<string, CodexSubAgentAccumulator>()
  private timer: NodeJS.Timeout | null = null
  private parentFile: string | null = null
  private dirty = false
  private stopped = false
  private readonly refreshLoop = new CoalescedRefresh(() => this.poll())
  private nextDiscoveryAt = 0

  constructor(
    private readonly onChange: (subAgents: Record<string, SubAgentState>) => void,
    private readonly now: () => number = Date.now,
  ) {}

  observeParentEntry(entry: JsonlEntry, file: string): void {
    if (this.stopped) return
    const oldRoot = this.parentFile ? sessionsRootFromRolloutPath(this.parentFile) : null
    const rootChanged = oldRoot !== sessionsRootFromRolloutPath(file)
    if (rootChanged) {
      // Offsets are meaningful only in their original files. A root change
      // must not attach a new provider archive to cached old-path fold state.
      this.childPathByAgentId.clear()
      this.childOffsetByAgentId.clear()
      this.childPartialByAgentId.clear()
      this.childAccByAgentId.clear()
      this.nextDiscoveryAt = 0
    }
    this.parentFile = file
    let changed = rootChanged
    const spawn = extractCodexSpawnCall(entry)
    if (spawn) {
      this.spawnsByCallId.set(spawn.callId, spawn)
      changed = true
    }
    const output = extractCodexSpawnOutput(entry)
    if (output) {
      this.outputsByCallId.set(output.callId, output)
      this.callIdByAgentId.set(output.agentId, output.callId)
      // Correlation changed for this agent. The child rollout bytes may not grow
      // at the same moment, but emit() still needs to rebuild the record with the
      // parent spawn/output metadata. Mark dirty without touching the byte offset;
      // the accumulator remains the source of truth for child-derived fields.
      changed = true
    }
    const waitCallId = isCodexWaitAgentCall(entry)
    if (waitCallId) this.waitCallIds.add(waitCallId)
    const waitStatuses = extractCodexWaitStatuses(entry, this.waitCallIds)
    if (waitStatuses) {
      // The wait_agent output is the parent's fan-in truth (#341): for
      // MCP-spawned children no notification ever arrives, so without this
      // the card runs forever. done/error recorded per agent uuid.
      for (const [agentId, terminal] of waitStatuses) {
        this.waitTerminalByAgentId.set(agentId, terminal)
      }
      // Prune the consumed wait call id. A wait_agent call produces exactly ONE
      // output, and extractCodexWaitStatuses only returns non-null once it has
      // matched (and thus consumed) that output — so this id will never match a
      // future entry again. Without this delete, waitCallIds grew unbounded for
      // the tracker's whole lifetime (it was only ever cleared in stop()), the
      // Codex twin of the retention leaks #300/#317 fixed elsewhere. The output
      // entry's call_id IS the id we tracked at the wait call, so re-reading it
      // here is the exact key to drop.
      const consumedCallId = stringField(asRecord(entry.payload), 'call_id')
      if (consumedCallId) this.waitCallIds.delete(consumedCallId)
      changed = true
    }
    const notification = extractCodexSubagentNotification(entry)
    if (notification) {
      this.notificationsByAgentId.set(notification.agentId, notification)
      // Notification status is parent-rollout metadata, not child bytes. A
      // completion notice must repaint even when the child file is quiescent.
      changed = true
    }
    if (this.knownAgentIds().length > 0) this.ensureTimer()
    if (changed) {
      this.dirty = true
      void this.refresh()
    }
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
    this.refreshLoop.stop()
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    // Mirror SubAgentWatcher.stop() (PR #300): clearing the timer alone left
    // every retained child rollout entry — plus the spawn/output/notification
    // correlation maps — pinned in main-process heap for the lifetime of the
    // process even though a stopped tracker can never emit again. A stopped
    // session must release its memory; the durable source stays the on-disk
    // rollout if the tracker is ever re-created for the same parent.
    this.spawnsByCallId.clear()
    this.waitCallIds.clear()
    this.waitTerminalByAgentId.clear()
    this.outputsByCallId.clear()
    this.callIdByAgentId.clear()
    this.notificationsByAgentId.clear()
    this.childPathByAgentId.clear()
    this.childOffsetByAgentId.clear()
    this.childPartialByAgentId.clear()
    this.childAccByAgentId.clear()
  }

  refresh(): Promise<void> {
    return this.refreshLoop.request()
  }

  private async poll(): Promise<void> {
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
    const ids = this.knownAgentIds()
    const missing = new Set(ids.filter(id => !this.childPathByAgentId.has(id)))
    if (missing.size > 0 && this.now() >= this.nextDiscoveryAt) {
      // One traversal serves ALL unresolved children, including misses from a
      // previous pass. No archive-sized filename cache is retained and no new
      // child bypasses the cooldown. #802 supplies the single in-flight owner.
      this.nextDiscoveryAt = this.now() + CODEX_CHILD_DISCOVERY_RETRY_MS
      const found = await findChildRollouts(root, missing, () => this.stopped)
      if (this.stopped || sessionsRootFromRolloutPath(this.parentFile!) !== root) return
      for (const [id, path] of found) this.childPathByAgentId.set(id, path)
    }
    for (const agentId of ids) {
      if (this.stopped) return
      const path = this.childPathByAgentId.get(agentId)
      if (!path) continue
      try {
        const changed = await this.readAppendedChild(agentId, path)
        if (this.stopped) return
        if (changed) this.dirty = true
      } catch (error) {
        if (this.stopped) return
        // A removed rollout must not poison every later child's activity
        // poll. Rediscover it in the next bounded window, with fresh offsets.
        const code = (error as NodeJS.ErrnoException).code
        if ((code === 'ENOENT' || code === 'ENOTDIR') && this.childPathByAgentId.get(agentId) === path) {
          this.childPathByAgentId.delete(agentId)
          this.childOffsetByAgentId.delete(agentId)
          this.childPartialByAgentId.delete(agentId)
          this.childAccByAgentId.delete(agentId)
        }
      }
    }
  }

  private async readAppendedChild(agentId: string, path: string): Promise<boolean> {
    const { size } = await stat(path)
    if (this.stopped || this.childPathByAgentId.get(agentId) !== path) return false
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
    // readKnownChildren's outer guard is too late: these maps must not be
    // repopulated after stop(), even if an open range read finishes afterwards.
    if (this.stopped || this.childPathByAgentId.get(agentId) !== path) return false
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
    const nowMs = Date.now()
    for (const [agentId, callId] of this.callIdByAgentId) {
      const state = buildCodexSubAgentStateFromAccumulator({
        toolUseId: callId,
        agentId,
        spawn: this.spawnsByCallId.get(callId) ?? null,
        output: this.outputsByCallId.get(callId) ?? null,
        notification: this.notificationsByAgentId.get(agentId) ?? null,
        waitTerminal: this.waitTerminalByAgentId.get(agentId) ?? null,
        acc: this.childAccByAgentId.get(agentId) ?? null,
        nowMs,
      })
      // #341 pruning: a child terminal for longer than the prune window
      // has its durable truth in the parent rollout (wait output /
      // notification) — the tracker's job is done. Dropping the fold
      // state caps long-lived resumed sessions that used to accumulate
      // dozens of dead cards; the row keeps rendering from committed
      // rows. Terminal-only: stale children stay tracked so a late
      // revival can still flip them back to running.
      const idleMs = state.lastActivityAt !== null ? nowMs - state.lastActivityAt : null
      if (
        (state.status === 'done' || state.status === 'error') &&
        idleMs !== null &&
        idleMs > CODEX_SUBAGENT_PRUNE_AFTER_MS
      ) {
        this.callIdByAgentId.delete(agentId)
        this.spawnsByCallId.delete(callId)
        this.outputsByCallId.delete(callId)
        this.notificationsByAgentId.delete(agentId)
        this.waitTerminalByAgentId.delete(agentId)
        this.childPathByAgentId.delete(agentId)
        this.childOffsetByAgentId.delete(agentId)
        this.childPartialByAgentId.delete(agentId)
        this.childAccByAgentId.delete(agentId)
        continue
      }
      out[callId] = state
    }
    this.onChange(out)
  }
}
