import { basename } from 'node:path'

import type { SessionManager } from '@main/sessionManager.js'
import type { PersistedWindow } from '@main/storage/workspaceFile.js'
import type { AgentActivityRange, AgentActivitySummary } from '@shared/agentActivity/summaryTypes.js'
import {
  INITIAL_WORKING_STATE,
  isWorking,
  reduceWorkingState,
} from '@shared/agentActivity/workingState.js'
import type { WorkingSignal, WorkingState } from '@shared/agentActivity/workingState.js'
import type { ProviderConditionSnapshot } from '@shared/types/providerConditions.js'
import type { SystemSuspension } from '@shared/types/systemSuspension.js'

import { conditionsBlockOnUser } from './attention.js'
import type { ActivityContext, AgentActivityStore, OpenInterval } from './AgentActivityStore.js'
import { rangeBounds, summarizeAgentActivity } from './summarize.js'
import { EMPTY_WORKSPACE_PROJECTION, projectWorkspace } from './workspaceProjection.js'
import type { WorkspaceProjection } from './workspaceProjection.js'

// Records when each agent was working (#964, decomposition Stage 4).
//
// WHY in main: sessions outlive renderer reloads, every window must get the same
// history, and main already receives every provider event before it is forwarded.
// A renderer-side recorder would double count across windows and lose whatever
// happened while a window was reloading.
//
// Lifecycle of one interval: the working-state reducer turns ON (a turn started
// streaming, not blocked on the user) → the start is kept in memory and in
// open.json → the reducer turns OFF (idle, blocked, removed) → the interval is
// written with the context the workspace had at that moment.
//
// Contexts are resolved at CLOSE time on purpose: a session's tab, title and agent
// name reach main only through the renderer's debounced workspace autosave, so at
// the moment a fresh agent starts working its metadata may not be saved yet.

const OPEN_TOUCH_INTERVAL_MS = 30_000

type SessionEntry = {
  state: WorkingState
  kind: string | null
  openedAt: number | null
  /** The session's tldrIdentity as main registered it at spawn. */
  identity?: string
}

export type AgentActivityRecorderDeps = {
  manager: Pick<SessionManager, 'on'>
  store: AgentActivityStore
  /** Main checkout of the repository holding `cwd`, or `cwd` itself. */
  resolveRepoRoot: (cwd: string) => Promise<string>
  /**
   * The tldrIdentity main registered for a session at spawn (the built-in MCP
   * host's scope). WHY (#1342 review b): the workspace projection reaches main
   * only through the renderer's debounced autosave, so a replacement that
   * finishes a turn and then crashes before that save never gets a placement
   * and its interval would stay keyed by its bare session id forever. The
   * renderer hands the identity to main in the spawn request, so main knows
   * it before any turn can close.
   */
  identityOf?: (sessionId: string) => string | undefined
}

export class AgentActivityRecorder {
  private readonly sessions = new Map<string, SessionEntry>()
  private projection: WorkspaceProjection = EMPTY_WORKSPACE_PROJECTION
  private agentNames: Readonly<Record<string, string>> = {}
  private touchTimer: ReturnType<typeof setInterval> | null = null
  private readonly pendingWrites = new Set<Promise<void>>()
  /** Alias edges already handed to the store this run (updateWorkspace). */
  private readonly aliasesSent = new Map<string, string>()

  constructor(private readonly deps: AgentActivityRecorderDeps) {}

  /** Settle every write already started (closed intervals, open-interval saves).
   *
   *  WHY a summary waits on this: an interval is written after its context
   *  resolves (a git lookup for the repository root). Someone who opens Agent
   *  Analytics the moment a turn ends would otherwise see that turn missing, then
   *  appear on the next open — a report that changes when nothing happened. */
  async flush(): Promise<void> {
    while (this.pendingWrites.size > 0) await Promise.all([...this.pendingWrites])
  }

  private track(write: Promise<void>): void {
    this.pendingWrites.add(write)
    void write.finally(() => this.pendingWrites.delete(write))
  }

  async start(): Promise<void> {
    await this.deps.store.recoverOpenIntervals(Date.now())
    const { manager } = this.deps
    manager.on('started', ({ sessionId, kind }) => {
      if (kind === 'terminal') return
      const entry = this.entry(sessionId)
      entry.kind = kind
      // Read at start, while the registration certainly exists: it can be
      // revoked with the process before this recorder handles 'removed'.
      entry.identity = this.deps.identityOf?.(sessionId) ?? entry.identity
    })
    manager.on('semantic-event', ({ sessionId, event }) => {
      this.signal(sessionId, { type: 'semantic', event })
    })
    manager.on('conditions', ({ sessionId, snapshot }: { sessionId: string; snapshot: ProviderConditionSnapshot }) => {
      if (!this.sessions.has(sessionId)) return
      this.signal(sessionId, { type: 'attention', blocked: conditionsBlockOnUser(snapshot) })
    })
    // `removed` is the reliable end: some provider stop() paths never emit exit
    // (forwarder.ts). `exit` is kept too, because it can precede removal.
    manager.on('removed', ({ sessionId }) => this.end(sessionId))
    manager.on('exit', ({ sessionId }) => this.end(sessionId))
    this.touchTimer = setInterval(() => { void this.persistOpen() }, OPEN_TOUCH_INTERVAL_MS)
    this.touchTimer.unref?.()
  }

  stop(): void {
    if (this.touchTimer) clearInterval(this.touchTimer)
    this.touchTimer = null
  }

  /** Follow the persisted workspace: tabs, titles, names, orchestration links. */
  updateWorkspace(windows: readonly PersistedWindow[], agentNames: Readonly<Record<string, string>>): void {
    this.projection = projectWorkspace(windows)
    this.agentNames = agentNames
    // Join provisional keys to the identity the projection now shows (#1302,
    // see AgentActivityStore.appendAliases): the session id, for intervals a
    // successor closed before its row was saved and for rows written before
    // tldrIdentity was part of the key; and the tldrIdentity, for an agent
    // that gets a name later. Only edges not sent before are queued, since
    // this runs on every autosave.
    const edges: Array<[string, string]> = []
    for (const [sessionId, placement] of this.projection.sessions) {
      const identity = placement.agentNameId ?? placement.tldrIdentity
      if (identity && identity !== sessionId) edges.push([sessionId, identity])
      if (placement.agentNameId && placement.tldrIdentity) edges.push([placement.tldrIdentity, placement.agentNameId])
    }
    const fresh = edges.filter(([from, to]) => this.aliasesSent.get(from) !== to)
    if (fresh.length > 0) {
      // Remembered as sent only once the store has it on disk (steering q63):
      // marking it first meant a failed append (full or read-only disk) was
      // never retried, and after a restart the old session-id row split
      // again. Until then, every autosave offers the edge once more; the
      // store drops the ones it already wrote.
      this.track(this.deps.store.appendAliases(fresh)
        .then(() => { for (const [from, to] of fresh) this.aliasesSent.set(from, to) })
        .catch(error => console.warn('[agent-activity] failed to record an alias:', error)))
    }
  }

  noteSuspension(suspension: SystemSuspension): void {
    void this.deps.store.appendSuspension(suspension)
  }

  async summary(range: AgentActivityRange): Promise<AgentActivitySummary> {
    await this.flush()
    const now = Date.now()
    const open = await this.openIntervals()
    const firstClosed = await this.deps.store.firstRecordedAt()
    const earliestOpen = open.reduce<number | null>((min, interval) => min === null || interval.startedAt < min ? interval.startedAt : min, null)
    const recordingSince = firstClosed === null
      ? earliestOpen
      : earliestOpen === null ? firstClosed : Math.min(firstClosed, earliestOpen)
    const { from, to } = rangeBounds(range, now, recordingSince)
    // ONE alias snapshot keys both the closed intervals and the open ones.
    // Round 3 (#1342 verification b): the open ones were not grouped at all.
    // Round 4: grouping them with a second snapshot taken after the reads let
    // an alias saved in between (an autosave landing mid-summary) give the two
    // sets different representatives, so one working agent showed twice.
    const group = await this.deps.store.agentKeyGrouping()
    const closed = await this.deps.store.readIntervals(from, to, group)
    return summarizeAgentActivity({
      // Agents working right now count up to this moment.
      intervals: [...closed, ...open.map(interval => ({
        context: { ...interval.context, agentKey: group(interval.context.agentKey) },
        startedAt: interval.startedAt,
        endedAt: now,
      }))],
      range,
      now,
      suspensions: await this.deps.store.readSuspensions(),
      openTabTitles: this.projection.openTabTitles,
      recordingSince,
    })
  }

  private entry(sessionId: string): SessionEntry {
    let entry = this.sessions.get(sessionId)
    if (!entry) {
      entry = { state: INITIAL_WORKING_STATE, kind: null, openedAt: null }
      this.sessions.set(sessionId, entry)
    }
    return entry
  }

  private isTerminal(sessionId: string, entry: SessionEntry): boolean {
    return entry.kind === 'terminal' || this.projection.sessions.get(sessionId)?.kind === 'terminal'
  }

  private signal(sessionId: string, signal: WorkingSignal): void {
    const entry = this.entry(sessionId)
    if (this.isTerminal(sessionId, entry)) return
    const wasWorking = isWorking(entry.state)
    entry.state = reduceWorkingState(entry.state, signal)
    const working = isWorking(entry.state)
    if (!wasWorking && working) {
      entry.openedAt = Date.now()
      this.track(this.persistOpen())
    } else if (wasWorking && !working) {
      this.close(sessionId, entry)
    }
  }

  private end(sessionId: string): void {
    const entry = this.sessions.get(sessionId)
    if (!entry) return
    this.signal(sessionId, { type: 'ended' })
    this.sessions.delete(sessionId)
  }

  private close(sessionId: string, entry: SessionEntry): void {
    const startedAt = entry.openedAt
    entry.openedAt = null
    if (startedAt === null) return
    const endedAt = Date.now()
    this.track(this.contextFor(sessionId, entry)
      .then(context => this.deps.store.appendInterval({ context, startedAt, endedAt }))
      .then(() => this.persistOpen())
      .catch(error => console.warn('[agent-activity] failed to record an interval:', error)))
  }

  private async contextFor(sessionId: string, entry: SessionEntry): Promise<ActivityContext> {
    const placement = this.projection.sessions.get(sessionId)
    const cwd = placement?.cwd ?? ''
    const agentName = placement?.agentNameId ? this.agentNames[placement.agentNameId] : undefined
    return {
      // WHY tldrIdentity before the session id (#1302): a reload, provider
      // switch, resume or MCP toggle gives the pane a new session id, and with
      // names off by default (98 of the owner's 98 agents had a tldrIdentity,
      // 3 a name) the old `agentNameId ?? sessionId` started a new row for the
      // same agent each time. The renderer carries tldrIdentity across exactly
      // the replacements that continue the same conversation
      // (tldrIdentityForReplacement) and mints a new one for a rewind, clone
      // or unrelated resume, which is the line between "same agent" and "new
      // agent". The name stays first so rows already keyed by it keep their
      // key; the session id is the last resort for an agent with neither.
      agentKey: placement?.agentNameId ?? placement?.tldrIdentity ?? entry.identity ?? sessionId,
      // What the user sees on the pane, then the agent's spoken name, then the folder.
      label: placement?.title ?? agentName ?? (cwd ? basename(cwd) : sessionId),
      role: placement?.orchestration ? 'orchestration' : 'user',
      provider: placement?.kind ?? entry.kind ?? 'unknown',
      tabId: placement?.tabId ?? null,
      tabTitle: placement?.tabTitle ?? null,
      repoRoot: cwd ? await this.deps.resolveRepoRoot(cwd).catch(() => cwd) : '',
      cwd,
    }
  }

  private async openIntervals(): Promise<OpenInterval[]> {
    const open: OpenInterval[] = []
    for (const [sessionId, entry] of this.sessions) {
      if (entry.openedAt === null) continue
      open.push({ sessionId, context: await this.contextFor(sessionId, entry), startedAt: entry.openedAt })
    }
    return open
  }

  private async persistOpen(): Promise<void> {
    try {
      await this.deps.store.writeOpen(await this.openIntervals(), Date.now())
    } catch (error) {
      console.warn('[agent-activity] failed to persist open intervals:', error)
    }
  }
}
