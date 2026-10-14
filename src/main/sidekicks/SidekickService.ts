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
//       router lease for `record.sessionId`
//   I3  only that window may write the record (every write is lease-checked
//       HERE, never trusted from the renderer)
//
// WHY main and not "whichever window created it": a sidekick outlives the
// window it was created in, and two windows that each believed they owned it
// would each autosave their own copy and overwrite one another — the drift
// `SessionMeta.agentNameId`'s comment describes for agent names. The router
// lease already answers "which window may act on this process" for every
// other session; sidekicks reuse that answer instead of inventing a second.

/** The router operations the service needs, injected so tests can drive a
 *  real store against a scripted router. Wired to windowRegistry in main. */
export type SidekickRouter = {
  /** The window holding a CURRENT lease for the session, else null. */
  holder(sessionId: string): string | null
  /** Claim for a window; null when another live window holds it. */
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
  now?: () => number
}

function field(meta: unknown, key: string): string | null {
  if (!meta || typeof meta !== 'object') return null
  const value = (meta as Record<string, unknown>)[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

export class SidekickService extends EventEmitter {
  private revision = 0
  private readonly now: () => number

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
    if (result.ok) this.changed()
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
   * debounced save can never overwrite the new holder's record.
   */
  async save(windowId: string, request: SidekickSaveRequest): Promise<SidekickWriteResult> {
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
    // Save does not change anything the index view shows except
    // lastActiveAt/title/kind; broadcasting on every debounced save would be
    // a broadcast per keystroke pause. Broadcast only when a summary field
    // actually moved.
    if (result.ok) this.changedIfSummaryMoved(request.id)
    return result
  }

  /**
   * Show a sidekick that no window holds.
   *
   * WHY attach CLAIMS the lease (plan ruling, 2026-10-14): the renderer's
   * `session:recover` would claim it anyway, but only after an async round
   * trip. Two windows opening the same sleeping sidekick at once would then
   * both insert the row and race the recover, and the loser would surface a
   * raw "owned by another window" error in its pane. Claiming here makes
   * exactly one winner and gives the other the honest `owned-elsewhere`.
   */
  attach(windowId: string, id: SidekickId): SidekickAttachResult {
    const record = this.find(id)
    if (!record) return { ok: false, reason: 'not-found' }
    const holder = this.deps.router.holder(record.sessionId)
    if (holder === windowId) return { ok: true, record }
    if (holder !== null) return { ok: false, reason: 'owned-elsewhere' }
    if (!this.deps.router.claim(record.sessionId, windowId)) return { ok: false, reason: 'window-gone' }
    this.changed()
    return { ok: true, record }
  }

  /**
   * "Open here": move a sidekick from the window holding it to this one.
   *
   * ORDER IS THE SAFETY PROPERTY: the lease moves FIRST, then the previous
   * holder is told. From the moment of the transfer every request the old
   * window can still make about this session — save here, kill-owned and
   * deliver-prompt in ipc/session.ts — fails its lease check, however long
   * its renderer takes to process `released`. Telling it first would leave
   * a window in which it believes it lost the sidekick but could still act.
   * The router flushes held events to the new owner as part of the transfer.
   */
  take(windowId: string, id: SidekickId): SidekickAttachResult {
    const record = this.find(id)
    if (!record) return { ok: false, reason: 'not-found' }
    const holder = this.deps.router.holder(record.sessionId)
    if (holder === windowId) return { ok: true, record }
    if (holder === null) return this.attach(windowId, id)
    this.deps.router.transfer(record.sessionId, windowId)
    if (this.deps.router.holder(record.sessionId) !== windowId) return { ok: false, reason: 'window-gone' }
    this.notifyReleased(holder, { sidekickId: id, sessionId: record.sessionId })
    this.changed()
    return { ok: true, record }
  }

  /**
   * Remove a sidekick for good: stop its process, drop its lease and record.
   *
   * WHY main kills with its own authority instead of asking the holder: the
   * user removes from the picker in whatever window they are in, and the
   * holder may be another window — or none. The kill goes through
   * SessionManager.killOwned with the ownership tuple the record holds, the
   * same proof a pane close sends; a mismatched tuple refuses rather than
   * killing something else. The conversation itself stays in the provider's
   * native store and in Conversations (plan Decision 8).
   */
  // The requester is not consulted (any window may remove); it is taken so the
  // IPC layer's signature matches every other mutation and a future audit
  // field has somewhere to come from.
  async remove(_requesterWindowId: string, id: SidekickId, caller: KillCaller = 'sidekick.remove'): Promise<SidekickWriteResult> {
    const record = this.find(id)
    if (!record) return { ok: false, reason: 'not-found' }
    const holder = this.deps.router.holder(record.sessionId)
    const kind = field(record.meta, 'kind')
    const cwd = field(record.meta, 'cwd')
    const providerRuntime = field(record.meta, 'providerRuntime')
    if (kind && cwd) {
      await this.deps.kill({
        sessionId: record.sessionId,
        kind: kind as SessionKillOptions['kind'],
        cwd,
        ...(providerRuntime ? { providerRuntime: providerRuntime as SessionKillOptions['providerRuntime'] } : {}),
        caller,
      }).catch(() => false)
    }
    this.deps.router.release(record.sessionId)
    await this.deps.store.commitSidekicks(current => ({
      version: 1,
      records: current.records.filter(entry => entry.id !== id),
    }))
    if (holder !== null) this.notifyReleased(holder, { sidekickId: id, sessionId: record.sessionId })
    this.changed()
    return { ok: true }
  }

  /**
   * Window close: which of the closing window's leases are sidekicks.
   *
   * WHY those are RELEASED instead of bequeathed with the rest (plan ruling):
   * the survivor merges the closed window's slice, and a slice never holds a
   * sidekick row (I1), so a transferred lease would route the sidekick's
   * events into a window that only builds orphan runtimes for them. Released,
   * the process keeps running and the next window to show the sidekick claims
   * it through `attach` + `session:recover` (which adopts the live backend
   * and reseeds through the router's gap path).
   */
  sidekickSessionIds(): Set<string> {
    return new Set(this.deps.store.sidekicks().records.map(record => record.sessionId))
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
    return {
      id: record.id,
      sessionId: record.sessionId,
      kind: field(record.meta, 'kind'),
      providerRuntime: field(record.meta, 'providerRuntime'),
      title: field(record.meta, 'title'),
      agentNameId: field(record.meta, 'agentNameId'),
      remoteConnectionId: field(record.meta, 'remoteConnectionId'),
      createdAt: record.createdAt,
      lastActiveAt: record.lastActiveAt,
      liveWindowId: this.deps.router.holder(record.sessionId),
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
