// Sidekicks: global agents shown in the right-docked Sidekick panel (#1493).
//
// WHY a sidekick is not "a session with no project": every other agent is
// owned by the project its row names (`SessionMeta.projectId`), and the
// renderer prunes any row without one at the autosave and rehydrate
// boundaries (renderer workspace/sessionOwnership.ts). A sidekick belongs to
// no project, to no lane and to no window, so it needs an owner that outlives
// all three. That owner is the record below, kept by main in its own section
// of workspace.json (main/storage/workspaceFile.ts). The renderer row is a
// projection of it, held by exactly one window at a time.
//
// WHY the record lives in workspace.json and not a sidekicks.json of its own:
// four main-side features only ever see sessions through the committed
// workspace document — the conversation ledger (marks absent sessions
// closed), TLDR/Goal eviction protection, Agent Activity titles and the Codex
// same-rollout handoff commit. One file means one commit queue and one place
// those readers look. See docs/plans/2026-10-14-sidekick-global-agents.md §3.

/** Opaque, stable across provider switches and reloads (the local SessionId
 *  is NOT: a replacement mints a new one). Minted by the renderer at creation
 *  with crypto.randomUUID(), validated by main. */
export type SidekickId = string

/**
 * The durable record of one sidekick.
 *
 * `meta` is the renderer's SessionMeta for the sidekick's current session,
 * OPAQUE to main exactly as window slices are (workspaceFile.ts header): main
 * reads a few narrow fields defensively for its projections and never decides
 * anything from the rest. Owning the schema in two processes is how they
 * would come to disagree.
 */
export type SidekickRecord = {
  id: SidekickId
  /** The local session id currently running this sidekick. Changes on Reload
   *  Agent, provider switch and rewind (the replacement mints a new id). */
  sessionId: string
  createdAt: number
  /** Last time the holding window saved this record. Drives picker order. */
  lastActiveAt: number
  meta: unknown
  /**
   * The composer draft. WHY here: autosave writes drafts only for rows in the
   * window slice, and a sidekick row is never in one (I1), so without this an
   * unsent prompt would not survive a restart — the one thing every lane
   * agent's composer already promises.
   */
  draft?: string
}

/** The `sidekicks` section of workspace.json. Array order is creation order. */
export type PersistedSidekicks = {
  version: 1
  records: SidekickRecord[]
}

export const EMPTY_PERSISTED_SIDEKICKS: PersistedSidekicks = Object.freeze({
  version: 1,
  records: Object.freeze([]) as unknown as SidekickRecord[],
}) as PersistedSidekicks

/** What every window renders from: the index plus where each one is live. */
export type SidekickSummary = {
  id: SidekickId
  sessionId: string
  kind: string | null
  providerRuntime: string | null
  title: string | null
  agentNameId: string | null
  remoteConnectionId: string | null
  createdAt: number
  lastActiveAt: number
  /** The window holding this sidekick's session lease, or null when no window
   *  holds it (asleep, or released by a closed window). */
  liveWindowId: string | null
}

export type SidekickIndexView = {
  /** Increases on every change, so a late broadcast never overwrites a newer
   *  snapshot in a renderer (sidekickIndexStore). */
  revision: number
  /** `os.homedir()`: the folder every sidekick starts in (plan Decision 4). */
  homeDir: string
  sidekicks: SidekickSummary[]
}

export type SidekickAttachResult =
  | { ok: true; record: SidekickRecord }
  | { ok: false; reason: 'not-found' | 'window-gone' | 'owned-elsewhere' }

export type SidekickWriteResult = { ok: true } | { ok: false; reason: string }

export type SidekickRegisterRequest = { id: SidekickId; sessionId: string; meta: unknown }
export type SidekickSaveRequest = { id: SidekickId; sessionId: string; meta: unknown; draft?: string }
export type SidekickReleasedEvent = { sidekickId: SidekickId; sessionId: string }

export const SIDEKICK_CHANNELS = {
  list: 'sidekick:list',
  register: 'sidekick:register',
  save: 'sidekick:save',
  attach: 'sidekick:attach',
  take: 'sidekick:take',
  remove: 'sidekick:remove',
  /** Broadcast to every window with the new SidekickIndexView. */
  changed: 'sidekick:changed',
  /** Sent to the one window that just lost a sidekick (moved or removed). */
  released: 'sidekick:released',
} as const

const SIDEKICK_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** WHY validated: the id is minted in the renderer and used as a record key in
 *  a file main writes; a free-form string would let any renderer bug invent
 *  colliding or path-like keys. UUID shape is all the renderer ever mints. */
export function isSidekickId(value: unknown): value is SidekickId {
  return typeof value === 'string' && SIDEKICK_ID_RE.test(value)
}
