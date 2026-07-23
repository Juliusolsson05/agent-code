import { DEFAULT_PROVIDER, isAgentProviderKind } from '@shared/types/providerKind'
import type {
  ManagedAgentMessage,
  ManagedAgentProject,
  ManagedAgentRecord,
  ManagedAgentRendererDescriptor,
  ManagedAgentRendererOutput,
  ManagedAgentTranscriptOutput,
} from '@mcp/shared/agentManagementTypes'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import { entryTextContent } from '@renderer/session-runtime/entries'
import { collectLeaves } from '@renderer/workspace/tile-tree/treeOps'
import { visibleMessageSummary } from '@renderer/workspace/orchestrationMcp'
import type { SessionId, SessionMeta, Tab, WorkspaceState } from '@renderer/workspace/types'

type RuntimeMap = Record<SessionId, SessionRuntime>

const DEFAULT_MAX_MESSAGES = 20
const DEFAULT_BULK_MAX_MESSAGES = 6
const DEFAULT_MAX_CHARS_PER_MESSAGE = 4_000
const DEFAULT_MAX_CHARS_PER_AGENT = 24_000
const DEFAULT_MAX_TOTAL_CHARS = 200_000

type ProjectMembership = {
  tab: Tab
  tabIndex: number
  placement: ManagedAgentRecord['placement']
}

function projectForSession(
  state: WorkspaceState,
  sessionId: SessionId,
): ProjectMembership | null {
  const matches: ProjectMembership[] = []
  state.tabs.forEach((tab, tabIndex) => {
    if (collectLeaves(tab.root).includes(sessionId)) {
      matches.push({ tab, tabIndex, placement: 'grid' })
    }
  })
  const detached = state.detachedSessions[sessionId]
  if (detached) {
    const tabIndex = state.tabs.findIndex(tab => tab.id === detached.projectTabId)
    const tab = state.tabs[tabIndex]
    if (tab) matches.push({ tab, tabIndex, placement: 'dispatch' })
  }
  for (const buried of state.buried) {
    if (buried.sessionId !== sessionId) continue
    const tabIndex = state.tabs.findIndex(tab => tab.id === buried.sourceTabId)
    const tab = state.tabs[tabIndex]
    if (tab) matches.push({ tab, tabIndex, placement: 'buried' })
  }
  // WHY ambiguous ownership fails closed: a corrupt save can put one local id
  // in more than one placement bucket. Choosing the first would make project
  // scope depend on iteration order and could authorize a cross-project target.
  return matches.length === 1 ? matches[0]! : null
}

function managedProject(membership: ProjectMembership): ManagedAgentProject {
  return {
    tabId: membership.tab.id,
    title: membership.tab.title,
    index: membership.tabIndex,
  }
}

function orderedProjectSessionIds(
  state: WorkspaceState,
  tabId: string,
): SessionId[] {
  const tab = state.tabs.find(candidate => candidate.id === tabId)
  if (!tab) return []
  const detached = Object.values(state.detachedSessions)
    .filter(item => item.projectTabId === tabId)
    .sort((a, b) => a.detachedAt - b.detachedAt)
    .map(item => item.sessionId)
  const buried = state.buried
    .filter(item => item.sourceTabId === tabId)
    .map(item => item.sessionId)
  return [...new Set([...collectLeaves(tab.root), ...detached, ...buried])]
}

function conditionSummary(runtime: SessionRuntime | undefined): {
  requiresUserAction: boolean
  conditionSummary?: string
} {
  const kinds = Object.keys(runtime?.conditions?.conditions ?? {})
  return {
    requiresUserAction: kinds.length > 0,
    ...(kinds.length > 0 ? { conditionSummary: kinds.join(', ') } : {}),
  }
}

function runtimeActivityAt(runtime: SessionRuntime | undefined): number | undefined {
  if (!runtime) return undefined
  const values = [
    runtime.phaseChangedAt,
    runtime.turnStartedAt,
    runtime.submittedAt,
  ].filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  return values.length > 0 ? Math.max(...values) : undefined
}

function latestVisibleConversationRole(
  runtime: SessionRuntime | undefined,
): 'user' | 'assistant' | null {
  if (!runtime) return null
  for (let index = runtime.entries.length - 1; index >= 0; index -= 1) {
    const entry = runtime.entries[index]!
    if (entry.type !== 'user' && entry.type !== 'assistant') continue
    const text = entryTextContent(entry)
    if (text?.trim()) return entry.type
  }
  return null
}

function hasUnansweredUserTurn(runtime: SessionRuntime | undefined): boolean {
  return latestVisibleConversationRole(runtime) === 'user'
}

export function managedTranscriptUnavailableReason(
  runtime: SessionRuntime | undefined,
  meta: SessionMeta | undefined,
): 'transcript_unavailable' | 'not_created' | null {
  if (!runtime) return meta?.providerSessionId ? 'transcript_unavailable' : 'not_created'
  // WHY an error/disconnected status remains authoritative even if a few
  // optimistic or previously cached entries survived: callers asked for the
  // durable transcript, and returning a partial tail as if hydration succeeded
  // would make missing evidence indistinguishable from a complete conversation.
  if (runtime.transcriptStatus === 'error' || runtime.transcriptStatus === 'disconnected') {
    return 'transcript_unavailable'
  }
  if (runtime.transcriptStatus === 'loading') return 'transcript_unavailable'
  return null
}

function activityState(runtime: SessionRuntime | undefined): ManagedAgentRecord['activityState'] {
  if (!runtime) return 'unknown'
  if (runtime.processStatus === 'failed' || runtime.processError) return 'failed'
  if (
    runtime.sessionStatus === 'running' ||
    runtime.processActive ||
    runtime.awaitingAssistant ||
    runtime.streamPhase !== 'idle'
  ) return 'running'
  // WHY completion follows the newest visible conversational turn rather than
  // the existence of any historical assistant message: a restored transcript
  // can contain many old answers and still end with a newer unanswered user
  // request. Labeling that shape completed would make it look safe to clean up.
  const latestRole = latestVisibleConversationRole(runtime)
  if (latestRole === 'user') return 'waiting'
  if (latestRole === 'assistant') return 'completed'
  if (runtime.inputReady || runtime.processStatus === 'started') return 'waiting'
  return 'unknown'
}

function backendState(runtime: SessionRuntime | undefined): ManagedAgentRecord['backendState'] {
  if (!runtime) return 'hibernated'
  if (runtime.processStatus === 'failed' || runtime.processError) return 'failed'
  if (runtime.processStatus === 'spawning') return 'spawning'
  if (runtime.processStatus === 'started' && runtime.exited === null) return 'live'
  return 'hibernated'
}

function statusSummary(runtime: SessionRuntime | undefined): string | undefined {
  if (!runtime) return 'hibernated'
  if (runtime.processError) return runtime.processError
  if (runtime.streamPhase !== 'idle') return runtime.streamPhase
  if (runtime.sessionStatus === 'running') return 'running'
  return activityState(runtime)
}

function descriptorForSession(params: {
  state: WorkspaceState
  runtimes: RuntimeMap
  callerSessionId: string
  sessionId: string
  membership: ProjectMembership
}): ManagedAgentRendererDescriptor | null {
  const meta = params.state.sessions[params.sessionId]
  const kind = meta?.kind ?? DEFAULT_PROVIDER
  if (!meta || !isAgentProviderKind(kind)) return null
  const runtime = params.runtimes[params.sessionId]
  const runtimeAt = runtimeActivityAt(runtime)
  const transcriptAt = runtime?.lastJsonlEntryAt ?? latestVisibleTimestamp(runtime)
  const summary = statusSummary(runtime)
  return {
    agent: {
      sessionId: params.sessionId,
      kind,
      cwd: meta.cwd,
      ...(meta.title ? { title: meta.title } : {}),
      project: managedProject(params.membership),
      placement: params.membership.placement,
      backendState: backendState(runtime),
      activityState: activityState(runtime),
      ...(summary ? { statusSummary: summary } : {}),
      transcript: {
        path: null,
        availability: meta.providerSessionId
          ? (kind === 'opencode' ? 'provider_managed' : 'unavailable')
          : 'not_created',
      },
      processActive: runtime?.processActive === true,
      // A hibernated runtime does not persist the transient awaitingAssistant
      // bit. Derive it from a trailing user turn as well so the inventory and
      // activityState cannot contradict the transcript evidence after restart.
      awaitingAssistant: runtime?.awaitingAssistant === true || hasUnansweredUserTurn(runtime),
      ...conditionSummary(runtime),
      isCaller: params.sessionId === params.callerSessionId,
      ...(meta.linkedParentId ? { linkedParentId: meta.linkedParentId } : {}),
      ...(meta.orchestrationParentId
        ? { orchestrationParentId: meta.orchestrationParentId }
        : {}),
      ...(meta.orchestrationRootId ? { orchestrationRootId: meta.orchestrationRootId } : {}),
      ...(meta.orchestrationRunId ? { orchestrationRunId: meta.orchestrationRunId } : {}),
      ...(meta.orchestrationRole ? { orchestrationRole: meta.orchestrationRole } : {}),
    },
    ...(meta.providerSessionId ? { providerSessionId: meta.providerSessionId } : {}),
    ...(transcriptAt ? { transcriptActivityAt: transcriptAt } : {}),
    ...(runtimeAt ? { runtimeActivityAt: runtimeAt } : {}),
  }
}

export function listManagedAgentDescriptors(params: {
  state: WorkspaceState
  runtimes: RuntimeMap
  callerSessionId: string
}): { project: ManagedAgentProject; agents: ManagedAgentRendererDescriptor[] } {
  const callerMembership = projectForSession(params.state, params.callerSessionId)
  if (!callerMembership) throw new Error('caller_not_found')
  const agents = orderedProjectSessionIds(params.state, callerMembership.tab.id)
    .map(sessionId => {
      const membership = projectForSession(params.state, sessionId)
      if (!membership || membership.tab.id !== callerMembership.tab.id) return null
      return descriptorForSession({ ...params, sessionId, membership })
    })
    .filter((value): value is ManagedAgentRendererDescriptor => value !== null)
  return { project: managedProject(callerMembership), agents }
}

export function assertManagedTarget(params: {
  state: WorkspaceState
  callerSessionId: string
  sessionId: string
  allowSelf?: boolean
}): ProjectMembership {
  const caller = projectForSession(params.state, params.callerSessionId)
  if (!caller) throw new Error('caller_not_found')
  const target = projectForSession(params.state, params.sessionId)
  if (!target || !params.state.sessions[params.sessionId]) throw new Error('agent_not_found')
  if (target.tab.id !== caller.tab.id) throw new Error('agent_not_in_project')
  const kind = params.state.sessions[params.sessionId]?.kind ?? DEFAULT_PROVIDER
  if (!isAgentProviderKind(kind)) throw new Error('agent_not_found')
  if (params.allowSelf !== true && params.sessionId === params.callerSessionId) {
    throw new Error('self_target_forbidden')
  }
  return target
}

export function readManagedAgentOutput(params: {
  state: WorkspaceState
  runtimes: RuntimeMap
  callerSessionId: string
  sessionId: string
  maxMessages?: number
  maxCharsPerMessage?: number
  maxCharsPerAgent?: number
}): ManagedAgentRendererOutput {
  const membership = assertManagedTarget({ ...params, allowSelf: true })
  const descriptor = descriptorForSession({ ...params, membership })
  if (!descriptor) throw new Error('agent_not_found')
  const runtime = params.runtimes[params.sessionId] ?? null
  const summary = visibleMessageSummary(
    runtime,
    undefined,
    bounded(params.maxMessages, 1, 100, DEFAULT_MAX_MESSAGES),
    bounded(params.maxCharsPerMessage, 50, 100_000, DEFAULT_MAX_CHARS_PER_MESSAGE),
    // Public MCP input is schema-clamped to >=100. Bulk reads may allocate a
    // smaller fair share when the total budget is divided across a very large
    // project; the shared scanner still returns a bounded newest excerpt.
    bounded(params.maxCharsPerAgent, 1, 500_000, DEFAULT_MAX_CHARS_PER_AGENT),
    runtime?.entries,
  )
  const output: ManagedAgentTranscriptOutput = {
    agent: descriptor.agent,
    messages: summary.messages as ManagedAgentMessage[],
    ...(summary.latestAssistantText ? { latestAssistantText: summary.latestAssistantText } : {}),
    ...(summary.truncated ? { truncated: true } : {}),
    ...(summary.totalChars > 0 ? { totalChars: summary.totalChars } : {}),
  }
  return {
    output,
    ...(descriptor.providerSessionId ? { providerSessionId: descriptor.providerSessionId } : {}),
    ...(descriptor.transcriptActivityAt
      ? { transcriptActivityAt: descriptor.transcriptActivityAt }
      : {}),
    ...(descriptor.runtimeActivityAt ? { runtimeActivityAt: descriptor.runtimeActivityAt } : {}),
  }
}

export function readManagedAgentOutputs(params: {
  state: WorkspaceState
  runtimes: RuntimeMap
  callerSessionId: string
  sessionIds?: string[]
  includeCaller?: boolean
  maxMessagesPerAgent?: number
  maxCharsPerMessage?: number
  maxCharsPerAgent?: number
  maxTotalChars?: number
}): {
  project: ManagedAgentProject
  agents: ManagedAgentRendererDescriptor[]
  outputs: ManagedAgentRendererOutput[]
  truncated: boolean
  totalChars: number
} {
  const listed = listManagedAgentDescriptors(params)
  const listedIds = new Set(listed.agents.map(item => item.agent.sessionId))
  const targetIds = params.sessionIds
    ? [...new Set(params.sessionIds)]
    : listed.agents
        .filter(item => params.includeCaller === true || !item.agent.isCaller)
        .map(item => item.agent.sessionId)
  for (const sessionId of targetIds) {
    if (!listedIds.has(sessionId)) throw new Error('agent_not_in_project')
  }

  const maxTotal = bounded(params.maxTotalChars, 1_000, 1_000_000, DEFAULT_MAX_TOTAL_CHARS)
  const maxPerAgent = bounded(
    params.maxCharsPerAgent,
    100,
    500_000,
    DEFAULT_MAX_CHARS_PER_AGENT,
  )
  const reserve = Math.min(
    4_000,
    maxPerAgent,
    Math.max(1, Math.floor(maxTotal / Math.max(1, targetIds.length))),
  )
  let remaining = maxTotal
  let totalChars = 0
  let truncated = false
  const outputs: ManagedAgentRendererOutput[] = []
  targetIds.forEach((sessionId, index) => {
    if (remaining < 1) {
      const descriptor = listed.agents.find(item => item.agent.sessionId === sessionId)
      if (!descriptor) throw new Error('agent_not_in_project')
      // WHY a starved agent gets an explicit empty/truncated output instead of
      // borrowing past maxTotalChars: bulk cleanup is one bounded MCP result.
      // Large projects can outnumber the minimum useful 100-char excerpts; an
      // honest omission preserves the hard cross-agent cap and the full census
      // still tells the caller exactly which agents need a narrower follow-up.
      outputs.push({
        output: {
          agent: descriptor.agent,
          messages: [],
          truncated: true,
        },
        ...(descriptor.providerSessionId
          ? { providerSessionId: descriptor.providerSessionId }
          : {}),
        ...(descriptor.transcriptActivityAt
          ? { transcriptActivityAt: descriptor.transcriptActivityAt }
          : {}),
        ...(descriptor.runtimeActivityAt
          ? { runtimeActivityAt: descriptor.runtimeActivityAt }
          : {}),
      })
      truncated = true
      return
    }
    const futureReserve = Math.max(0, targetIds.length - index - 1) * reserve
    const available = Math.max(1, remaining - futureReserve)
    const budget = Math.min(maxPerAgent, available)
    const output = readManagedAgentOutput({
      ...params,
      sessionId,
      maxMessages: params.maxMessagesPerAgent ?? DEFAULT_BULK_MAX_MESSAGES,
      maxCharsPerAgent: budget,
    })
    // The single-agent convenience mirror duplicates transcript text in JSON.
    // Bulk reads omit it so maxTotalChars is a real response-content ceiling,
    // not a messages-only estimate that can be exceeded by mirror fields.
    const { latestAssistantText: _latestAssistantText, ...boundedOutput } = output.output
    output.output = boundedOutput
    const used = output.output.messages.reduce((sum, message) => sum + message.text.length, 0)
    remaining = Math.max(0, remaining - used)
    totalChars += used
    if (output.output.truncated || budget < maxPerAgent) truncated = true
    outputs.push(output)
  })
  return { ...listed, outputs, truncated, totalChars }
}

export function additionalCloseImpact(params: {
  state: WorkspaceState
  callerSessionId: string
  sessionId: string
}): SessionId[] {
  const membership = assertManagedTarget(params)
  const affected = new Set<SessionId>()
  const visitLinked = (parentId: SessionId): void => {
    for (const [sessionId, meta] of Object.entries(params.state.sessions)) {
      if (meta.linkedParentId !== parentId || affected.has(sessionId)) continue
      affected.add(sessionId)
      visitLinked(sessionId)
    }
  }
  visitLinked(params.sessionId)
  if (membership.placement === 'grid') {
    const leaves = collectLeaves(membership.tab.root)
    if (leaves.length === 1) {
      for (const sessionId of orderedProjectSessionIds(params.state, membership.tab.id)) {
        if (sessionId !== params.sessionId) affected.add(sessionId)
      }
    }
  }
  return [...affected]
}

function latestVisibleTimestamp(runtime: SessionRuntime | undefined): number | undefined {
  if (!runtime) return undefined
  for (let index = runtime.entries.length - 1; index >= 0; index -= 1) {
    const entry = runtime.entries[index]
    if (entry.type !== 'user' && entry.type !== 'assistant') continue
    if (!entryTextContent(entry)?.trim()) continue
    const raw = (entry as { timestamp?: unknown }).timestamp
    if (typeof raw !== 'string') continue
    const parsed = Date.parse(raw)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function bounded(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.floor(value)))
}
