import { EventEmitter } from 'node:events'

import type { WorkspaceFileStore } from '@main/storage/workspaceFileStore.js'
import { isSidekickId } from '@shared/sidekicks/types.js'
import type {
  SidekickAttachResult,
  SidekickId,
  SidekickIndexView,
  SidekickRecord,
  SidekickRegisterRequest,
  SidekickReleasedEvent,
  SidekickSaveRequest,
  SidekickSummary,
  SidekickWriteResult,
} from '@shared/sidekicks/types.js'
import type { KillCaller } from '@shared/lifecycle/events.js'
import type { SessionKillOptions } from '@shared/types/session.js'

// The owner of every sidekick (#1493). See docs/plans/2026-10-14-sidekick-global-agents.md
// §1 for the invariants this file enforces:
//
//   I1  the record in workspace.json is the durable truth; no window slice
//       ever holds a sidekick row (the renderer's autosave enforces that half)
//   I2  at most one window holds a sidekick's row — the window holding the
//       router lease for the sidekick's CURRENT session
//   I3  only that window may write the record (every write is lease-checked
//       HERE, never trusted from the renderer)
//
// WHY main and not "whichever window created it": a sidekick outlives the
// window it was created in, and two windows that each believed they owned it
// would each autosave their own copy and overwrite one another — the drift
// `SessionMeta.agentNameId`'s comment describes for agent names. The router
// lease already answers "which window may act on this process" for every
// other session; sidekicks reuse that answer instead of inventing a second.
//
// THE CURRENT SESSION IS NOT ALWAYS THE DURABLE ONE (review round 1, C2/C3):
// Reload Agent and provider switch mint a successor session in the holding
// window, and the renderer reports it to `save` only after its debounce. A
// `take` or `remove` acting on the durable `record.sessionId` in that window
// moved or killed the RETIRED session — two owners, or a successor left
// running with no record. Main learns of the successor at spawn time instead
// (`noteSpawnClaimed`, wired from session:spawn, which carries the
// predecessor id), so every decision below uses `currentSessionId`.

/** The router operations the service needs, injected so tests can drive a
 *  real store against a scripted router. Wired to windowRegistry in main. */
export type SidekickRouter = {
  /** The window holding a CURRENT lease for the session, else null. */
  holder(sessionId: string): string | null
  /**
   * The window the router has the session filed under, current OR stale
   * (a renderer that reloaded keeps its lease at an old generation until its
   * recover re-claims). WHY separate from `holder` (review round 1, C5): a
   * stale owner makes `holder` null, but `claim` still refuses every other
   * window while that owner's window lives — so treating it as "nobody
   * holds it" left the sidekick untakeable.
   */
  owner(sessionId: string): string | null
  /** Claim for a window; false when another live window holds it. */
  claim(sessionId: string, windowId: string): boolean
  /** Move an existing lease to `windowId` (the router's only handoff). */
  transfer(sessionId: string, windowId: string): void
  /** Drop whatever lease the session has. */
  release(sessionId: string): void
  sendToWindow(windowId: string, channel: string, payload: unknown): boolean
}

export type SidekickServiceDeps = {
  store: Pick<WorkspaceFileStore, 'sidekicks' | 'commitSidekicks'>
  router: SidekickRouter
  kill(options: SessionKillOptions): Promise<boolean>
  homeDir: string
  releasedChannel: string
  /**
   * After any committed change to the index. Main wires this to
   * commitDurableOwnership (review round 1, C4): `collectSessionIds` counts
   * sidekick sessions, but only a WINDOW save used to ask SessionManager to
   * acknowledge them, so a Codex sidekick's same-rollout handoff stayed
   * pending — and the next Reload Agent waited on it forever — whenever no
   * window happened to save (a read-only or partially restored workspace).
   */
  onCommitted?: () => void
  now?: () => number
}

/** What a spawn told main about a sidekick's newest session, before any save. */
type LiveSuccessor = {
  sessionId: string
  previous: string
  /** The ownership tuple the successor was spawned with: a provider switch
   *  changes `kind`, and a moved row must be recovered as what it now is. */
  kind: string | null
  providerRuntime: string | null
  cwd: string | null
}

function field(meta: unknown, key: string): string | null {
  if (!meta || typeof meta !== 'object') return null
  const value = (meta as Record<string, unknown>)[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

export class SidekickService extends EventEmitter {
  private revision = 0
  private readonly now: () => number
  private readonly live = new Map<SidekickId, LiveSuccessor>()
  private readonly removing = new Set<SidekickId>()

  constructor(private readonly deps: SidekickServiceDeps) {
    super()
    this.now = deps.now ?? Date.now
  }

  view(): SidekickIndexView {
    return {
      revision: this.revision,
      homeDir: this.deps.homeDir,
      sidekicks: this.deps.store.sidekicks().records.map(record => this.summarize(record)),
    }
  }

  /** The session currently running this sidekick: a spawned successor the
   *  renderer has not saved yet, else the durable one. */
  private currentSessionId(record: SidekickRecord): string {
    return this.live.get(record.id)?.sessionId ?? record.sessionId
  }

  /**
   * session:spawn claimed `sessionId` for a window, replacing `predecessor`.
   * If the predecessor is a sidekick's current session, the successor becomes
   * its current session NOW (C2). A sidekick being removed gets its successor
   * killed instead (C3): nothing durable will ever name it.
   */
  noteSpawnClaimed(predecessor: string | undefined, sessionId: string, spawned: { kind?: string; providerRuntime?: string; cwd?: string }): void {
    if (!predecessor) return
    const record = this.deps.store.sidekicks().records.find(entry => this.currentSessionId(entry) === predecessor)
    if (!record) return
    if (this.removing.has(record.id)) {
      void this.killQuietly(sessionId, spawned.kind ?? field(record.meta, 'kind'), spawned.providerRuntime ?? null, spawned.cwd ?? field(record.meta, 'cwd'))
      return
    }
    this.live.set(record.id, {
      sessionId,
      previous: predecessor,
      kind: spawned.kind ?? null,
      providerRuntime: spawned.providerRuntime ?? null,
      cwd: spawned.cwd ?? null,
    })
  }

  /** A spawn that claimed a successor then failed: the predecessor is still current. */
  noteSpawnFailed(sessionId: string): void {
    for (const [id, successor] of this.live) {
      if (successor.sessionId === sessionId) this.live.delete(id)
    }
  }

  /**
   * File a freshly spawned session as a sidekick.
   *
   * WHY the renderer mints the id and spawns first: the renderer must set
   * `sidekickId` on the row in the SAME commit that spawn's row lands
   * (fileSessionAsSidekick), or its autosave sees an unowned row for one tick.
   * Main still decides: the requester must hold the new session's lease,
   * which `session:spawn` granted it at id-mint time.
   */
  async register(windowId: string, request: SidekickRegisterRequest): Promise<SidekickWriteResult> {
    if (!isSidekickId(request.id)) return { ok: false, reason: 'invalid sidekick id' }
    let result: SidekickWriteResult = { ok: false, reason: 'not committed' }
    await this.deps.store.commitSidekicks(current => {
      if (this.deps.router.holder(request.sessionId) !== windowId) {
        result = { ok: false, reason: 'this window does not hold the session' }
        return current
      }
      if (current.records.some(record => record.id === request.id || record.sessionId === request.sessionId)) {
        result = { ok: false, reason: 'already registered' }
        return current
      }
      const at = this.now()
      result = { ok: true }
      return { version: 1, records: [...current.records, { id: request.id, sessionId: request.sessionId, createdAt: at, lastActiveAt: at, meta: request.meta }] }
    })
    if (result.ok) {
      this.deps.onCommitted?.()
      this.changed()
    }
    return result
  }

  /**
   * The one write path for a sidekick's meta, session id and draft (I3).
   *
   * A different `sessionId` is a replacement (Reload Agent, provider switch,
   * rewind mint a new local id). It is accepted only from the window that
   * holds the NEW session, and only when the OLD one is held by that same
   * window or by nobody (the replacement retired it). A window that lost the
   * sidekick through `take` fails the first check, so a slow renderer's late
   * debounced save can never overwrite the new holder's record. A sidekick
   * being removed accepts no saves (C3).
   */
  async save(windowId: string, request: SidekickSaveRequest): Promise<SidekickWriteResult> {
    if (this.removing.has(request.id)) return { ok: false, reason: 'being removed' }
    let result: SidekickWriteResult = { ok: false, reason: 'not committed' }
    await this.deps.store.commitSidekicks(current => {
      const index = current.records.findIndex(record => record.id === request.id)
      const existing = current.records[index]
      if (!existing) {
        result = { ok: false, reason: 'not-found' }
        return current
      }
      if (this.deps.router.holder(request.sessionId) !== windowId) {
        result = { ok: false, reason: 'this window does not hold the session' }
        return current
      }
      if (request.sessionId !== existing.sessionId) {
        const previousHolder = this.deps.router.holder(existing.sessionId)
        if (previousHolder !== null && previousHolder !== windowId) {
          result = { ok: false, reason: 'the previous session is held by another window' }
          return current
        }
      }
      const next: SidekickRecord = {
        ...existing,
        sessionId: request.sessionId,
        meta: request.meta,
        lastActiveAt: this.now(),
      }
      if (typeof request.draft === 'string' && request.draft.length > 0) next.draft = request.draft
      else delete next.draft
      result = { ok: true }
      const records = current.records.slice()
      records[index] = next
      return { version: 1, records }
    })
    if (result.ok) {
      // The durable record has caught up with the spawned successor.
      if (this.live.get(request.id)?.sessionId === request.sessionId) this.live.delete(request.id)
      this.deps.onCommitted?.()
      this.changedIfSummaryMoved(request.id)
    }
    return result
  }

  /**
   * Show a sidekick no window currently holds.
   *
   * WHY attach CLAIMS the lease (plan ruling, Task 2): the renderer's
   * `session:recover` would claim it anyway, but only after an async round
   * trip; two windows opening the same sleeping sidekick at once would both
   * insert the row and race the recover. Claiming here makes one winner.
   *
   * A STALE owner (its renderer reloaded and has not re-claimed yet, C5) is
   * not "someone else's": its window may not even show the sidekick any more.
   * The lease is transferred, and the stale owner told, exactly as `take`.
   */
  attach(windowId: string, id: SidekickId): SidekickAttachResult {
    const record = this.find(id)
    if (!record) return { ok: false, reason: 'not-found' }
    const sessionId = this.currentSessionId(record)
    const holder = this.deps.router.holder(sessionId)
    if (holder === windowId) return { ok: true, record: this.presented(record) }
    if (holder !== null) return { ok: false, reason: 'owned-elsewhere' }
    return this.acquire(windowId, record)
  }

  /**
   * "Open here": move a sidekick from the window holding it to this one.
   *
   * ORDER IS THE SAFETY PROPERTY: the lease moves FIRST, then the previous
   * holder is told. From the moment of the transfer every request the old
   * window can still make about this session — save here, kill-owned, and
   * (since review round 1, C1) session:input and session:deliver-prompt —
   * fails its lease check, however long its renderer takes to process
   * `released`. The router flushes held events to the new owner as part of
   * the transfer. The CURRENT session moves (C2), never a retired one.
   */
  take(windowId: string, id: SidekickId): SidekickAttachResult {
    const record = this.find(id)
    if (!record) return { ok: false, reason: 'not-found' }
    const sessionId = this.currentSessionId(record)
    if (this.deps.router.holder(sessionId) === windowId) return { ok: true, record: this.presented(record) }
    return this.acquire(windowId, record)
  }

  /** Claim a free session, or transfer it from whichever window is filed as
   *  its owner (current or stale) and tell that window. */
  private acquire(windowId: string, record: SidekickRecord): SidekickAttachResult {
    const sessionId = this.currentSessionId(record)
    const previous = this.deps.router.holder(sessionId) ?? this.deps.router.owner(sessionId)
    if (previous === null || previous === windowId) {
      if (!this.deps.router.claim(sessionId, windowId)) return { ok: false, reason: 'window-gone' }
    } else {
      this.deps.router.transfer(sessionId, windowId)
      if (this.deps.router.holder(sessionId) !== windowId) return { ok: false, reason: 'window-gone' }
      this.notifyReleased(previous, { sidekickId: record.id, sessionId })
    }
    this.changed()
    return { ok: true, record: this.presented(record) }
  }

  /**
   * The record as the new holder must adopt it: under its CURRENT session,
   * with the ownership tuple that session was spawned with when the renderer
   * has not saved it yet (a provider switch changes `kind`; recovering the
   * moved row as the old kind would be an ownership conflict).
   */
  private presented(record: SidekickRecord): SidekickRecord {
    const successor = this.live.get(record.id)
    if (!successor) return record
    const meta = record.meta && typeof record.meta === 'object' ? { ...(record.meta as Record<string, unknown>) } : {}
    if (successor.kind) meta.kind = successor.kind
    if (successor.cwd) meta.cwd = successor.cwd
    if (successor.providerRuntime) meta.providerRuntime = successor.providerRuntime
    else delete meta.providerRuntime
    return { ...record, sessionId: successor.sessionId, meta }
  }

  /**
   * Remove a sidekick for good: stop its process, drop its lease and record.
   *
   * WHY main kills with its own authority instead of asking the holder: the
   * user removes from the picker in whatever window they are in, and the
   * holder may be another window — or none. Each kill goes through
   * SessionManager.killOwned with an ownership tuple; a mismatched tuple
   * refuses rather than killing something else. The conversation itself
   * stays in the provider's native store and in Conversations (Decision 8).
   *
   * C3: the sidekick is marked `removing` BEFORE the first await, so a
   * replacement saved or spawned while the kill runs cannot outlive it — the
   * save is refused and the spawned successor is killed (noteSpawnClaimed).
   * Both the current session and a not-yet-saved successor's predecessor are
   * stopped; killOwned refuses whichever no longer exists.
   */
  async remove(_requesterWindowId: string, id: SidekickId, caller: KillCaller = 'sidekick.remove'): Promise<SidekickWriteResult> {
    const record = this.find(id)
    if (!record) return { ok: false, reason: 'not-found' }
    if (this.removing.has(id)) return { ok: false, reason: 'being removed' }
    this.removing.add(id)
    try {
      const presented = this.presented(record)
      const holder = this.deps.router.holder(presented.sessionId) ?? this.deps.router.owner(presented.sessionId)
      const sessions = new Set([presented.sessionId, record.sessionId])
      for (const sessionId of sessions) {
        const meta = sessionId === presented.sessionId ? presented.meta : record.meta
        await this.killQuietly(sessionId, field(meta, 'kind'), field(meta, 'providerRuntime'), field(meta, 'cwd'), caller)
        this.deps.router.release(sessionId)
      }
      this.live.delete(id)
      await this.deps.store.commitSidekicks(current => ({
        version: 1,
        records: current.records.filter(entry => entry.id !== id),
      }))
      if (holder !== null) this.notifyReleased(holder, { sidekickId: id, sessionId: presented.sessionId })
      this.deps.onCommitted?.()
      this.changed()
      return { ok: true }
    } finally {
      this.removing.delete(id)
    }
  }

  private async killQuietly(sessionId: string, kind: string | null, providerRuntime: string | null, cwd: string | null, caller: KillCaller = 'sidekick.remove'): Promise<void> {
    if (!kind || !cwd) return
    await this.deps.kill({
      sessionId,
      kind: kind as SessionKillOptions['kind'],
      cwd,
      ...(providerRuntime ? { providerRuntime: providerRuntime as SessionKillOptions['providerRuntime'] } : {}),
      caller,
    }).catch(() => false)
  }

  /**
   * Window close: which of the closing window's leases are sidekicks.
   *
   * WHY those are RELEASED instead of bequeathed with the rest (plan ruling):
   * the survivor merges the closed window's slice, and a slice never holds a
   * sidekick row (I1), so a transferred lease would route the sidekick's
   * events into a window that only builds orphan runtimes for them. Released,
   * the process keeps running and the next window to show the sidekick claims
   * it through `attach` + `session:recover`.
   */
  sidekickSessionIds(): Set<string> {
    const ids = new Set<string>()
    for (const record of this.deps.store.sidekicks().records) {
      ids.add(record.sessionId)
      ids.add(this.currentSessionId(record))
    }
    return ids
  }

  releaseForClosedWindow(sessionIds: readonly string[]): void {
    let moved = false
    for (const sessionId of sessionIds) {
      this.deps.router.release(sessionId)
      moved = true
    }
    if (moved) this.changed()
  }

  private find(id: SidekickId): SidekickRecord | undefined {
    return this.deps.store.sidekicks().records.find(record => record.id === id)
  }

  private summarize(record: SidekickRecord): SidekickSummary {
    const presented = this.presented(record)
    return {
      id: record.id,
      sessionId: presented.sessionId,
      kind: field(presented.meta, 'kind'),
      providerRuntime: field(presented.meta, 'providerRuntime'),
      title: field(presented.meta, 'title'),
      agentNameId: field(presented.meta, 'agentNameId'),
      remoteConnectionId: field(presented.meta, 'remoteConnectionId'),
      createdAt: record.createdAt,
      lastActiveAt: record.lastActiveAt,
      liveWindowId: this.deps.router.holder(presented.sessionId),
    }
  }

  private lastSummaries = new Map<SidekickId, string>()

  private changedIfSummaryMoved(id: SidekickId): void {
    const record = this.find(id)
    if (!record) return
    const { lastActiveAt: _ignored, ...summary } = this.summarize(record)
    const key = JSON.stringify(summary)
    if (this.lastSummaries.get(id) === key) return
    this.lastSummaries.set(id, key)
    this.changed()
  }

  private notifyReleased(windowId: string, event: SidekickReleasedEvent): void {
    this.deps.router.sendToWindow(windowId, this.deps.releasedChannel, event)
  }

  private changed(): void {
    this.revision += 1
    this.emit('changed', this.view())
  }
}

/**
 * Split a closing window's leases into the ones a survivor inherits and the
 * sidekick ones that must be released instead (see
 * SidekickService.releaseForClosedWindow for why). Pure so the window-close
 * composition in main/index.ts is pinned by a test without a BrowserWindow.
 */
export function partitionClosedWindowSessions(
  ownedByClosedWindow: readonly string[],
  sidekickSessionIds: ReadonlySet<string>,
): { bequeathed: string[]; sidekicks: string[] } {
  const bequeathed: string[] = []
  const sidekicks: string[] = []
  for (const sessionId of ownedByClosedWindow) {
    if (sidekickSessionIds.has(sessionId)) sidekicks.push(sessionId)
    else bequeathed.push(sessionId)
  }
  return { bequeathed, sidekicks }
}
