import { DEFAULT_PROVIDER, isAgentProviderKind } from '@shared/types/providerKind'
import type {
  ManagedAgentMessage,
  ManagedAgentProject,
  ManagedAgentRecord,
  ManagedAgentRendererActivitySource,
  ManagedAgentRendererDescriptor,
  ManagedAgentRendererOutput,
  ManagedAgentTranscriptOutput,
} from '@mcp/shared/agentManagementTypes'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import { entryTextContent } from '@renderer/session-runtime/entries'
import { projectIdOf, resolveTabSessions } from '@renderer/workspace/queries'
import { visibleMessageSummary } from '@renderer/workspace/orchestrationMcp'
import type { SessionId, SessionMeta, Tab, WorkspaceState } from '@renderer/workspace/types'
import { sessionActivity } from '@renderer/session-runtime/activity'

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
  // The row says which project it belongs to. A session whose project is gone
  // (or that was never filed) has no project scope and is refused — scope
  // must never be guessed, because it is what authorizes a cross-agent read.
  //
  // Until #992 membership was searched across three owner structures (tile
  // leaves, detached records, buried records) and a session found in more than
  // one FAILED CLOSED: a corrupt save could make project scope depend on
  // iteration order. One field cannot be ambiguous.
  //
  // `placement` stays 'dispatch' for every session: in this contract that
  // value has always meant "a row in the project's agent index", which is what
  // every pool session is. 'grid' and 'buried' named v2 owners that no longer
  // exist; the enum is narrowed with the rest of the MCP surface in stage 7.
  const projectId = projectIdOf(state, sessionId)
  if (projectId === undefined) return null
  const tabIndex = state.tabs.findIndex(tab => tab.id === projectId)
  const tab = state.tabs[tabIndex]
  return tab ? { tab, tabIndex, placement: 'dispatch' } : null
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
  // Index order, from the one membership query. (Until #992 this concatenated
  // tile leaves, detached rows by detachedAt, then buried panes.)
  return resolveTabSessions(state, tabId)
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

/**
 * The UNIFIED answer to "when was this agent last active" (#915), and which
 * class of evidence produced it.
 *
 * Shared with the TLDR peek footer on purpose — see `sessionActivity`. The
 * source travels WITH the value because only this side knows it: the bridge
 * receives one number and, when it labelled that number by where it arrived
 * from, published a JSONL watermark as `lastActivitySource: 'runtime'`.
 *
 * This replaces the raw `transcriptActivityAt`/`runtimeActivityAt` pair the
 * descriptor used to carry. They were justified as evidence "an existing
 * caller may read" — the descriptor is renderer-private and never reaches an
 * MCP caller, and once the bridge stopped recombining them nothing read them
 * at all.
 */
function lastActive(runtime: SessionRuntime | undefined): {
  lastActiveAt?: number
  lastActiveSource?: ManagedAgentRendererActivitySource
} {
  const { timestamp, source } = sessionActivity(runtime)
  if (timestamp === null || source === null) return {}
  return { lastActiveAt: timestamp, lastActiveSource: source }
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
  const activity = lastActive(runtime)
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
      // A placeholder: main replaces it with the resolved locator (a JSONL
      // path, or opencode://session/<id>) before anything reaches the MCP.
      transcript: {
        path: null,
        availability: meta.providerSessionId ? 'unavailable' : 'not_created',
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
    ...activity,
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
    ...forwardedActivity(descriptor),
  }
}

/**
 * Carry the descriptor's activity answer onto an output record.
 *
 * WHY a helper rather than two spreads at each site: both read paths forward
 * it, and a site that forgets is invisible — the bridge just falls back to the
 * weakest candidate it has and the agent still gets A number.
 */
function forwardedActivity(descriptor: ManagedAgentRendererDescriptor): {
  lastActiveAt?: number
  lastActiveSource?: ManagedAgentRendererActivitySource
} {
  return {
    ...(descriptor.lastActiveAt ? { lastActiveAt: descriptor.lastActiveAt } : {}),
    ...(descriptor.lastActiveSource ? { lastActiveSource: descriptor.lastActiveSource } : {}),
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
        ...forwardedActivity(descriptor),
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
  assertManagedTarget(params)
  const affected = new Set<SessionId>()
  const visitLinked = (parentId: SessionId): void => {
    for (const [sessionId, meta] of Object.entries(params.state.sessions)) {
      if (meta.linkedParentId !== parentId || affected.has(sessionId)) continue
      affected.add(sessionId)
      visitLinked(sessionId)
    }
  }
  visitLinked(params.sessionId)
  // WHY a project's last grid leaf no longer reports its siblings (#886 review
  // M1): it used to, because closing that leaf removed the tab and killed every
  // detached session in it. This tool closes with `requireConfirmation`, which
  // never offers the human-only Close Tab choice, so the close is session-scoped
  // and promotes the next Dispatch row into the grid instead. Reporting the
  // siblings would refuse a close that affects exactly one agent AND tell the
  // calling model that sessions would die which would not — data it acts on.
  // Linked descendants still count: the session-scoped close still ends them.
  return [...affected]
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
