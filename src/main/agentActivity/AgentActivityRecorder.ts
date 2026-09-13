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
}

export type AgentActivityRecorderDeps = {
  manager: Pick<SessionManager, 'on'>
  store: AgentActivityStore
  /** Main checkout of the repository holding `cwd`, or `cwd` itself. */
  resolveRepoRoot: (cwd: string) => Promise<string>
}

export class AgentActivityRecorder {
  private readonly sessions = new Map<string, SessionEntry>()
  private projection: WorkspaceProjection = EMPTY_WORKSPACE_PROJECTION
  private agentNames: Readonly<Record<string, string>> = {}
  private touchTimer: ReturnType<typeof setInterval> | null = null
  private readonly pendingWrites = new Set<Promise<void>>()

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
    const closed = await this.deps.store.readIntervals(from, to)
    return summarizeAgentActivity({
      // Agents working right now count up to this moment.
      intervals: [...closed, ...open.map(interval => ({ context: interval.context, startedAt: interval.startedAt, endedAt: now }))],
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
      agentKey: placement?.agentNameId ?? sessionId,
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
